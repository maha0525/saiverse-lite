import { BlobReader, BlobWriter, ZipReader, configure, type FileEntry } from "@zip.js/zip.js";
import { MAX_JSON_ELEMENT_CHARS, PackError, isObject } from "./format";
import { iterJsonArray } from "./jsonStream";

configure({ useWebWorkers: false });

/** A pack ZIP. Reads ranges of the Blob, so the file itself never sits in memory. */
export class PackArchive {
  private constructor(
    private readonly reader: ZipReader<Blob>,
    private readonly entries: Map<string, FileEntry>,
    readonly uncompressedBytes: number,
  ) {}

  static async open(file: Blob): Promise<PackArchive> {
    // validate.ts judges the names, so a refused path is reported as one.
    const reader = new ZipReader(new BlobReader(file), { filenameValidation: "tolerant" });
    try {
      const entries = new Map<string, FileEntry>();
      let total = 0;
      for (const entry of await reader.getEntries()) {
        total += entry.uncompressedSize;
        // A repeated name reads as its last entry, as in Python's zipfile.
        if (!entry.directory) entries.set(entry.filename, entry);
      }
      return new PackArchive(reader, entries, total);
    } catch (error) {
      await reader.close().catch(() => undefined);
      console.warn("[SAIVerse Lite][pack] ZIP could not be opened", error);
      throw new PackError("ZIP ファイルとして読めません");
    }
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
    if (!entry) throw new PackError(`パックに ${name} がありません`);
    return entry;
  }

  /** The entry's bytes as they inflate. Leaving the loop stops the inflating. */
  async *chunks(name: string): AsyncGenerator<Uint8Array> {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const stream = this.entry(name).getData(writable);
    const reader = readable.getReader();
    // Reported from the read below; attached here so a stopped loop leaves no unhandled rejection.
    let failure: unknown = null;
    const finished = stream.catch((error: unknown) => { failure = error; return reader.cancel(error); });
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
      if (failure === null) throw error;
    } finally {
      if (!completed) await reader.cancel().catch(() => undefined);
    }
    if (failure !== null) {
      console.warn("[SAIVerse Lite][pack] entry could not be read", { name, error: failure });
      throw new PackError(`${name} を読み出せません`);
    }
  }

  async blob(name: string, type = ""): Promise<Blob> {
    return await this.entry(name).getData(new BlobWriter(type));
  }

  async bytes(name: string): Promise<Uint8Array> {
    return new Uint8Array(await (await this.blob(name)).arrayBuffer());
  }

  /** body: importer.py read_json_document. For the single documents that are not arrays. */
  async jsonDocument(name: string, maxChars = MAX_JSON_ELEMENT_CHARS): Promise<unknown> {
    const tooLarge = () => new PackError(`${name} が上限の ${maxChars} 文字を超えています`);
    if (this.size(name) > 4 * maxChars) throw tooLarge();
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await this.bytes(name));
    } catch (error) {
      if (error instanceof TypeError) throw new PackError(`${name} が UTF-8 として読めません`);
      throw error;
    }
    if (text.length > maxChars) throw tooLarge();
    try {
      return JSON.parse(text);
    } catch {
      throw new PackError(`${name} の JSON が壊れています`);
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
      if (!isObject(row)) throw new PackError(`${name} の ${index + 1} 番目の要素がオブジェクトではありません`);
      for (const key of required) {
        if (row[key] === undefined || row[key] === null || row[key] === "") throw new PackError(`${name} の ${index + 1} 番目の要素に ${key} がありません`);
      }
      yield row;
      index += 1;
    }
  }

  async close(): Promise<void> {
    await this.reader.close();
  }
}
