/** A ZIP being written out, on disk so a large pack does not sit in memory. */
export interface PackWorkFile {
  readonly writable: WritableStream<Uint8Array>;
  /** The finished ZIP, once `writable` has closed. It stays until the next `openWork` or `clearWork`. */
  file(): Promise<Blob>;
  /** Drops what was written. */
  abort(): Promise<void>;
}

/** Keeps the original ZIP of each imported persona: `packs/<persona_id>.zip`. */
export interface PackStore {
  /** Why a pack cannot be kept here, or null when it can. */
  unavailableReason(): Promise<string | null>;
  /** Bytes still free for this origin, or null when the browser does not say. */
  freeBytes(): Promise<number | null>;
  /** A stopped write leaves what was stored before. */
  put(personaId: string, file: Blob): Promise<void>;
  get(personaId: string): Promise<Blob | null>;
  /** Removes the stored ZIP and any work file of the persona. */
  delete(personaId: string): Promise<void>;
  openWork(personaId: string): Promise<PackWorkFile>;
  /** Removes every work file, so one left by a closed tab does not hold storage. */
  clearWork(): Promise<void>;
}

const PACKS_DIRECTORY = "packs";
const WORK_DIRECTORY = "pack-work";
const UNAVAILABLE = "このブラウザは大きなファイルの保存に対応していません。最新のブラウザで開いてください。";

function packFileName(personaId: string): string {
  return `${encodeURIComponent(personaId)}.zip`;
}

function isNotFound(error: unknown): boolean {
  return error instanceof DOMException && error.name === "NotFoundError";
}

export class OpfsPackStore implements PackStore {
  private async directory(): Promise<FileSystemDirectoryHandle> {
    const root = await navigator.storage.getDirectory();
    return root.getDirectoryHandle(PACKS_DIRECTORY, { create: true });
  }

  async unavailableReason(): Promise<string | null> {
    if (typeof navigator === "undefined" || !navigator.storage?.getDirectory) return UNAVAILABLE;
    if (typeof FileSystemFileHandle === "undefined" || !("createWritable" in FileSystemFileHandle.prototype)) return UNAVAILABLE;
    try {
      await this.directory();
      return null;
    } catch (error) {
      console.warn("[SAIVerse Lite][pack] OPFS is not usable", error);
      return UNAVAILABLE;
    }
  }

  async freeBytes(): Promise<number | null> {
    if (!navigator.storage?.estimate) return null;
    const { quota, usage } = await navigator.storage.estimate();
    return quota === undefined ? null : quota - (usage ?? 0);
  }

  async put(personaId: string, file: Blob): Promise<void> {
    const directory = await this.directory();
    const handle = await directory.getFileHandle(packFileName(personaId), { create: true });
    // createWritable writes aside and replaces the file on close; pipeTo aborts it on failure.
    await file.stream().pipeTo(await handle.createWritable());
  }

  async get(personaId: string): Promise<Blob | null> {
    try {
      const directory = await this.directory();
      const handle = await directory.getFileHandle(packFileName(personaId));
      return await handle.getFile();
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  private async workDirectory(): Promise<FileSystemDirectoryHandle> {
    const root = await navigator.storage.getDirectory();
    return root.getDirectoryHandle(WORK_DIRECTORY, { create: true });
  }

  private async removeFrom(directory: FileSystemDirectoryHandle, name: string): Promise<void> {
    try {
      await directory.removeEntry(name);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }

  async delete(personaId: string): Promise<void> {
    await this.removeFrom(await this.directory(), packFileName(personaId));
    await this.removeFrom(await this.workDirectory(), packFileName(personaId));
  }

  async openWork(personaId: string): Promise<PackWorkFile> {
    const directory = await this.workDirectory();
    const name = packFileName(personaId);
    const handle = await directory.getFileHandle(name, { create: true });
    // ZipWriter locks `writable`, and `abort` has to reach the file past that lock.
    const output = (await handle.createWritable()).getWriter();
    return {
      writable: new WritableStream<Uint8Array>({
        write: (chunk) => output.write(chunk),
        close: () => output.close(),
        abort: (reason) => output.abort(reason),
      }),
      file: () => handle.getFile(),
      abort: async () => {
        await output.abort().catch(() => undefined);
        await this.removeFrom(directory, name);
      },
    };
  }

  async clearWork(): Promise<void> {
    const directory = await this.workDirectory();
    for await (const name of directory.keys()) await this.removeFrom(directory, name);
  }
}

export class MemoryPackStore implements PackStore {
  private readonly files = new Map<string, Blob>();
  /** The ZIPs a finished work file holds. */
  readonly work = new Map<string, Blob>();

  constructor(private readonly reason: string | null = null, private readonly free: number | null = null) {}

  async unavailableReason(): Promise<string | null> { return this.reason; }
  async freeBytes(): Promise<number | null> { return this.free; }
  async put(personaId: string, file: Blob): Promise<void> { this.files.set(personaId, file); }
  async get(personaId: string): Promise<Blob | null> { return this.files.get(personaId) ?? null; }
  async delete(personaId: string): Promise<void> {
    this.files.delete(personaId);
    this.work.delete(personaId);
  }

  async openWork(personaId: string): Promise<PackWorkFile> {
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    return {
      // ZipWriter reuses its buffers.
      writable: new WritableStream<Uint8Array>({ write: (chunk) => { chunks.push(chunk.slice()); } }),
      file: async () => {
        const blob = new Blob(chunks);
        this.work.set(personaId, blob);
        return blob;
      },
      abort: async () => { this.work.delete(personaId); },
    };
  }

  async clearWork(): Promise<void> { this.work.clear(); }
}
