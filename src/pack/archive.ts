import { BlobReader, BlobWriter, ZipReader, configure, type FileEntry } from "@zip.js/zip.js";
import { MAX_JSON_ELEMENT_CHARS, PackError, PackFormatError, isObject, parseJson } from "./format";
import { iterJsonArray } from "./jsonStream";

configure({ useWebWorkers: false });

/** A pack ZIP. Reads ranges of the Blob, so the file itself never sits in memory. */
export class PackArchive {
  private constructor(
    private readonly reader: ZipReader<Blob>,
    private readonly entries: Map<string, FileEntry>,
    private readonly listing: readonly string[],
    readonly uncompressedBytes: number,
  ) {}

  static async open(file: Blob): Promise<PackArchive> {
    // validate.ts judges the names, so a refused path is reported as one.
    // checkCrc32: body zipfile checks the CRC of every entry it reads.
    const reader = new ZipReader(new BlobReader(file), { filenameValidation: "tolerant", checkCrc32: true });
    try {
      const entries = new Map<string, FileEntry>();
      const listing: string[] = [];
      let total = 0;
      for (const entry of await reader.getEntries()) {
        total += entry.uncompressedSize;
        if (entry.directory) continue;
        // A repeated name reads as its last entry, as in Python's zipfile.
        entries.set(entry.filename, entry);
        listing.push(JSON.stringify([entry.filename, entry.crc32, entry.uncompressedSize]));
      }
      return new PackArchive(reader, entries, listing.sort(), total);
    } catch (error) {
      await reader.close().catch(() => undefined);
      console.warn("[SAIVerse Lite][pack] ZIP could not be opened", error);
      throw new PackFormatError("ZIP ファイルとして読めません");
    }
  }

  /**
   * What tells one pack from another: the name, CRC and size of every entry, from the ZIP's
   * listing, so no entry is read. Zipping the same files again gives the same value.
   * `crypto.subtle` needs a Secure Context, and so does the OPFS an import cannot start without.
   */
  async fingerprint(): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(this.listing.join("\n")));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  get names(): string[] {
    return [...this.entries.keys()];
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  size(name: string): number {
    return this.entries.get(name)?.uncompressedSize ?? 0;
  }

  private entry(name: string): FileEntry {
    const entry = this.entries.get(name);
    if (!entry) throw new PackFormatError(`パックに ${name} がありません`);
    return entry;
  }

  /** The entry's bytes as they inflate. Leaving the loop stops the inflating. */
  async *chunks(name: string): AsyncGenerator<Uint8Array> {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const stream = this.entry(name).getData(writable);
    const reader = readable.getReader();
    // Reported from the read below; attached here so a stopped loop leaves no unhandled rejection.
    let failure: unknown = null;
    const finished = stream.catch(async (error: unknown) => {
      failure = error;
      await reader.cancel(error).catch(() => undefined);
    });
    let completed = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        yield value;
      }
      await finished;
      completed = true;
    } catch (error) {
      // The same failure can reach this read before the handler above has run.
      failure ??= error;
    } finally {
      if (!completed) await reader.cancel().catch(() => undefined);
    }
    if (failure !== null) {
      console.warn("[SAIVerse Lite][pack] entry could not be read", { name, error: failure });
      throw new PackFormatError(`${name} を読み出せません`);
    }
  }

  async blob(name: string, type = ""): Promise<Blob> {
    const entry = this.entry(name);
    try {
      return await entry.getData(new BlobWriter(type));
    } catch (error) {
      console.warn("[SAIVerse Lite][pack] entry could not be read", { name, error });
      throw new PackFormatError(`${name} を読み出せません`);
    }
  }

  async bytes(name: string): Promise<Uint8Array> {
    return new Uint8Array(await (await this.blob(name)).arrayBuffer());
  }

  /** body: importer.py read_json_document. For the single documents that are not arrays. */
  async jsonDocument(name: string, maxChars = MAX_JSON_ELEMENT_CHARS): Promise<unknown> {
    const tooLarge = () => new PackFormatError(`${name} が上限の ${maxChars} 文字を超えています`);
    if (this.size(name) > 4 * maxChars) throw tooLarge();
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await this.bytes(name));
    } catch (error) {
      if (error instanceof TypeError) throw new PackFormatError(`${name} が UTF-8 として読めません`);
      throw error;
    }
    if (text.length > maxChars) throw tooLarge();
    try {
      return parseJson(text);
    } catch {
      throw new PackFormatError(`${name} の JSON が壊れています`);
    }
  }

  jsonArray(name: string, maxElementChars = MAX_JSON_ELEMENT_CHARS): AsyncGenerator<unknown> {
    return iterJsonArray(this.chunks(name), name, { maxElementChars });
  }

  /** body: importer.py _PackReader.iter_rows. Nothing comes from a file the pack does not have. */
  async *rows(name: string, required: readonly string[] = []): AsyncGenerator<Record<string, unknown>> {
    if (!this.has(name)) return;
    let index = 0;
    for await (const row of this.jsonArray(name)) {
      if (!isObject(row)) throw new PackFormatError(`${name} の ${index + 1} 番目の要素がオブジェクトではありません`);
      for (const key of required) {
        if (row[key] === undefined || row[key] === null || row[key] === "") throw new PackFormatError(`${name} の ${index + 1} 番目の要素に ${key} がありません`);
      }
      yield row;
      index += 1;
    }
  }

  async close(): Promise<void> {
    await this.reader.close();
  }
}
