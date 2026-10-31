/** Keeps the original ZIP of each imported persona: `packs/<persona_id>.zip`. */
export interface PackStore {
  /** Why a pack cannot be kept here, or null when it can. */
  unavailableReason(): Promise<string | null>;
  /** Bytes still free for this origin, or null when the browser does not say. */
  freeBytes(): Promise<number | null>;
  /** A stopped write leaves what was stored before. */
  put(personaId: string, file: Blob): Promise<void>;
  get(personaId: string): Promise<Blob | null>;
  delete(personaId: string): Promise<void>;
}

const PACKS_DIRECTORY = "packs";
const UNAVAILABLE = "このブラウザは大きなファイルの保存に対応していないため、取り込めません。最新のブラウザで開いてください。";

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

  async delete(personaId: string): Promise<void> {
    try {
      await (await this.directory()).removeEntry(packFileName(personaId));
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
}

export class MemoryPackStore implements PackStore {
  private readonly files = new Map<string, Blob>();

  constructor(private readonly reason: string | null = null, private readonly free: number | null = null) {}

  async unavailableReason(): Promise<string | null> { return this.reason; }
  async freeBytes(): Promise<number | null> { return this.free; }
  async put(personaId: string, file: Blob): Promise<void> { this.files.set(personaId, file); }
  async get(personaId: string): Promise<Blob | null> { return this.files.get(personaId) ?? null; }
  async delete(personaId: string): Promise<void> { this.files.delete(personaId); }
}
