import { Uint8ArrayReader, ZipWriter } from "@zip.js/zip.js";
import type { ChatMessage, ConversationThread, FragmentRecord, MessagePosition, PageRecord, Persona, PersonaSession } from "../domain";
import { redactValue } from "../memory/notices";
import { withOriginLock } from "../originLock";
import { CATEGORY_CHRONICLE } from "../pageRecords";
import type { LiteRepository } from "../storage/repository";
import { PackArchive } from "./archive";
import { FORMAT_NAME, FORMAT_VERSION, MANIFEST_NAME, PackError, base64ToBytes, decodeText, epochToIso, isObject, refusedJsonTextColumns, stringifyJson } from "./format";
import { profileText, readActiveThreadSuffix, readProfileDocument, storageShortage } from "./importPack";
import type { PackStore, PackWorkFile } from "./packStore";
import { fragmentToRow, messageToRow, pageFromRow, pageToRow, stelisThreadToRow, threadRowId, threadSuffix, threadToRow } from "./rows";
import {
  ACTIVE_STATE_FILE,
  ATTACHMENT_INDEX_FILE,
  FRAGMENTS_FILE,
  MESSAGES_FILE,
  MESSAGE_JSON_COLUMNS,
  MESSAGE_REQUIRED,
  PAGES_FILE,
  PAGE_JSON_COLUMNS,
  PAGE_REQUIRED,
  PROFILE_FILE,
  STELIS_THREADS_FILE,
  THREADS_FILE,
  readManifest,
  type PackManifest,
} from "./validate";

const EXPORT_LOCK = "saiverse-lite-pack-export";
const BATCH_ROWS = 300;
const GENERATOR_NAME = "saiverse-lite";
const CHANGES_FORMAT = "saiverse-lite-changes";
const CHANGES_FILE = "extensions/lite/changes.json";
const LITE_FOLDER = "extensions/lite";
const SAIVERSE_FOLDER = "extensions/saiverse";
/** body: export.py FOLDER_ORDER, and extensions/lite after it. */
const FOLDER_ORDER = ["profile", "chatlog", "knowledge", "attachments", "avatar", "voice", "items", "journal", SAIVERSE_FOLDER, "chatgpt_compat", LITE_FOLDER];
const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/avif": "avif", "image/bmp": "bmp", "image/gif": "gif", "image/jpeg": "jpg",
  "image/png": "png", "image/svg+xml": "svg", "image/webp": "webp",
};
const PROFILE_KEYS = ["AINAME", "SYSTEMPROMPT", "DESCRIPTION"] as const;

export type PackExportStage = "threads" | "messages" | "pages" | "fragments" | "profile" | "images" | "files" | "finishing";

export interface PackExportProgress {
  stage: PackExportStage;
  done: number;
  /** Null while the count is not known. */
  total: number | null;
}

/** extensions/lite/changes.json: docs/intent/persona_pack.md「Lite から帰るときの合流」. */
export interface PackChanges {
  format: typeof CHANGES_FORMAT;
  version: 1;
  /** `changed_at` lets the body show when Lite made the edit. Epoch seconds. */
  messages: { created: string[]; edited: Array<string | { id: string; changed_at: number }>; deleted: string[] };
  pages: { created: string[]; edited: string[]; deleted: string[] };
  fragments: { created: string[] };
  profile: { edited: string[] };
}

export interface PackExportResult {
  file: Blob;
  fileName: string;
  changes: PackChanges;
  /** What did not come across, for the screen. */
  warnings: string[];
}

/** A handy_tool row whose `metadata.imageDataUrl` becomes a file in attachments/. */
interface PendingImage {
  messageId: string;
  uri: string;
  path: string;
  mimeType: string;
}

interface PackSource {
  archive: PackArchive;
  manifest: PackManifest;
}

function dataUrlMimeType(url: string): string | null {
  const match = /^data:([^;,]+)[^,]*;base64,/.exec(url.slice(0, 256));
  return match?.[1] ?? null;
}

function dataUrlBytes(url: unknown): Uint8Array | null {
  if (typeof url !== "string" || dataUrlMimeType(url) === null) return null;
  try {
    return base64ToBytes(url.slice(url.indexOf(",") + 1));
  } catch (error) {
    console.warn("[SAIVerse Lite][pack] image could not be decoded", error);
    return null;
  }
}

function imageFileName(stem: string, mimeType: string): string {
  return `${stem.replace(/[^A-Za-z0-9_-]/g, "_")}.${IMAGE_EXTENSIONS[mimeType] ?? "bin"}`;
}

/** The entries of the ZIP being written. Every JSON passes one place that takes the passphrase out. */
class PackOutput {
  readonly folders = new Set<string>();
  readonly names = new Set<string>();
  private readonly encoder = new TextEncoder();

  constructor(readonly zip: ZipWriter<unknown>, private readonly passphrase: string) {}

  private text(value: unknown, indent?: number): string {
    return stringifyJson(this.passphrase ? redactValue(value, this.passphrase) : value, indent);
  }

  private register(folder: string, name: string): void {
    this.folders.add(folder);
    this.names.add(name);
  }

  async bytes(folder: string, name: string, bytes: Uint8Array): Promise<void> {
    this.register(folder, name);
    await this.zip.add(name, new Uint8ArrayReader(bytes));
  }

  document(folder: string, name: string, value: unknown): Promise<void> {
    return this.bytes(folder, name, this.encoder.encode(this.text(value, 2)));
  }

  /** body: export.py write_json_array. Elements are read one at a time, and the array is never held. */
  async rows(folder: string, name: string, rows: AsyncIterable<unknown>): Promise<void> {
    this.register(folder, name);
    const iterator = rows[Symbol.asyncIterator]();
    let count = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        const next = await iterator.next();
        if (next.done) {
          controller.enqueue(this.encoder.encode(count ? "\n]\n" : "[]\n"));
          controller.close();
          return;
        }
        controller.enqueue(this.encoder.encode(`${count ? ",\n" : "[\n"}${this.text(next.value)}`));
        count += 1;
      },
      cancel: async () => { await iterator.return?.(); },
    });
    await this.zip.add(name, stream);
  }
}

class PackExportRun {
  readonly changes: PackChanges = {
    format: CHANGES_FORMAT,
    version: 1,
    messages: { created: [], edited: [], deleted: [] },
    pages: { created: [], edited: [], deleted: [] },
    fragments: { created: [] },
    profile: { edited: [] },
  };
  /** A row came from a pack, so there was a ZIP to compare with. */
  sawSource = false;
  unsavedImages = 0;
  private readonly images: PendingImage[] = [];
  private readonly declared: Set<string>;

  constructor(
    private readonly persona: Persona,
    private readonly session: PersonaSession | undefined,
    private readonly repository: LiteRepository,
    private readonly pack: PackSource | null,
    private readonly output: PackOutput,
    private readonly onProgress: (progress: PackExportProgress) => void,
  ) {
    this.declared = pack?.manifest.contents ?? new Set();
  }

  private get personaId(): string {
    return this.persona.id;
  }

  /** The original rows of `name` to compare with: only a folder its manifest declares was ever read. */
  private originalRows(folder: string, name: string, required: readonly string[]): AsyncGenerator<Record<string, unknown>> | null {
    return this.pack && this.declared.has(folder) ? this.pack.archive.rows(name, required) : null;
  }

  private async *threadRows(threads: ConversationThread[]): AsyncGenerator<unknown> {
    let done = 0;
    for (const thread of threads) {
      this.sawSource ||= Boolean(thread.source);
      const row = threadToRow(thread);
      if (row) yield row;
      done += 1;
      this.onProgress({ stage: "threads", done, total: threads.length });
    }
  }

  private async *stelisRows(threads: ConversationThread[]): AsyncGenerator<unknown> {
    for (const thread of threads) yield stelisThreadToRow(thread);
  }

  /** The stored row with its generated image pointing at a file in attachments/ instead. */
  private withStoredImage(message: ChatMessage): ChatMessage {
    const { imageDataUrl, ...metadata } = message.metadata;
    if (typeof imageDataUrl !== "string") return message;
    const mimeType = dataUrlMimeType(imageDataUrl);
    if (mimeType === null) {
      this.unsavedImages += 1;
      return message;
    }
    const name = imageFileName(`lite_${message.id}`, mimeType);
    const uri = `saiverse://image/${name}`;
    this.images.push({ messageId: message.id, uri, path: `attachments/image/${name}`, mimeType });
    const images = Array.isArray(metadata.images) ? metadata.images : [];
    return { ...message, metadata: { ...metadata, images: [...images, { uri, mime_type: mimeType }] } };
  }

  private async *messageRows(): AsyncGenerator<unknown> {
    const { messages } = this.changes;
    const seen = new Set<string>();
    let start: MessagePosition | undefined;
    for (;;) {
      const batch = await this.repository.readPersonaMessages(this.personaId, { direction: "forward", limit: BATCH_ROWS, ...(start ? { start } : {}) });
      for (const stored of batch) {
        seen.add(stored.id);
        start = stored;
        if (!stored.source) messages.created.push(stored.id);
        else {
          this.sawSource = true;
          if (stored.content !== decodeText(stored.source.content)) {
            messages.edited.push(stored.editedAt === null ? stored.id : { id: stored.id, changed_at: Math.floor(stored.editedAt / 1000) });
          }
        }
        const message = this.withStoredImage(stored);
        yield messageToRow(message, threadRowId(message.threadId, this.personaId));
      }
      this.onProgress({ stage: "messages", done: seen.size, total: null });
      if (batch.length < BATCH_ROWS) break;
    }
    for await (const row of this.originalRows("chatlog", MESSAGES_FILE, MESSAGE_REQUIRED) ?? []) {
      const id = String(row.id);
      if (seen.has(id)) continue;
      seen.add(id);
      // The import left this row out, so Lite did not delete it. It stays in the pack as it came.
      if (refusedJsonTextColumns(row, MESSAGE_JSON_COLUMNS).length) yield row;
      else messages.deleted.push(id);
    }
  }

  private notePageChange(page: PageRecord): void {
    const { pages } = this.changes;
    if (!page.source) {
      pages.created.push(page.id);
      return;
    }
    this.sawSource = true;
    if (page.category === CATEGORY_CHRONICLE) return;
    const original = pageFromRow(page.source, page.personaId);
    if (page.isDeleted) {
      if (!original.isDeleted) pages.deleted.push(page.id);
    } else if (page.title !== original.title || page.summary !== original.summary || page.content !== original.content) {
      pages.edited.push(page.id);
    }
  }

  private async *pageRows(stored: PageRecord[]): AsyncGenerator<unknown> {
    const seen = new Set<string>();
    for (const page of stored) {
      seen.add(page.id);
      this.notePageChange(page);
      yield pageToRow(page);
      if (seen.size % BATCH_ROWS === 0) this.onProgress({ stage: "pages", done: seen.size, total: stored.length });
    }
    for await (const row of this.originalRows("knowledge", PAGES_FILE, PAGE_REQUIRED) ?? []) {
      const id = String(row.id);
      if (seen.has(id)) continue;
      seen.add(id);
      if (refusedJsonTextColumns(row, PAGE_JSON_COLUMNS).length) yield row;
      else if (row.category !== CATEGORY_CHRONICLE && !row.is_deleted) this.changes.pages.deleted.push(id);
    }
  }

  private async *fragmentRows(stored: FragmentRecord[]): AsyncGenerator<unknown> {
    for (const fragment of stored) {
      if (fragment.source) this.sawSource = true;
      else this.changes.fragments.created.push(fragment.id);
      yield fragmentToRow(fragment);
    }
  }

  private async writeChatlog(threads: ConversationThread[]): Promise<void> {
    const firstMessage = await this.repository.readPersonaMessages(this.personaId, { direction: "forward", limit: 1 });
    if (!this.declared.has("chatlog") && threads.length === 0 && firstMessage.length === 0) return;
    await this.output.rows("chatlog", THREADS_FILE, this.threadRows(threads));
    await this.output.rows("chatlog", MESSAGES_FILE, this.messageRows());
    // Lite makes no Stelis thread and offers none for deletion, so a ZIP's file is copied as it is.
    const stelis = threads.filter((thread) => thread.stelis);
    if (!this.pack && stelis.length) await this.output.rows("chatlog", STELIS_THREADS_FILE, this.stelisRows(stelis));
  }

  private async writeKnowledge(): Promise<void> {
    const pages = await this.repository.listPages(this.personaId);
    if (this.declared.has("knowledge") || pages.length) await this.output.rows("knowledge", PAGES_FILE, this.pageRows(pages));
  }

  private async writeFragments(): Promise<void> {
    this.onProgress({ stage: "fragments", done: 0, total: null });
    const fragments = await this.repository.listFragments(this.personaId);
    if (this.declared.has(SAIVERSE_FOLDER) || fragments.length) await this.output.rows(SAIVERSE_FOLDER, FRAGMENTS_FILE, this.fragmentRows(fragments));
  }

  /** The file holds more than Lite reads, so an unchanged one is left to be copied. */
  private async writeActiveState(threads: ConversationThread[]): Promise<void> {
    const active = this.session?.activeThreadId;
    if (!active || !threads.some((thread) => thread.id === active)) return;
    const suffix = threadSuffix(threadRowId(active, this.personaId));
    let state: Record<string, unknown> = {};
    if (this.pack) {
      const { archive, manifest } = this.pack;
      const current = await readActiveThreadSuffix(archive, manifest);
      if (current !== null && threadSuffix(current) === suffix) return;
      if (this.declared.has(SAIVERSE_FOLDER) && archive.has(ACTIVE_STATE_FILE)) {
        const document = await archive.jsonDocument(ACTIVE_STATE_FILE).catch(() => null);
        if (isObject(document)) state = document;
      }
    }
    await this.output.document(SAIVERSE_FOLDER, ACTIVE_STATE_FILE, { ...state, active_thread_id: suffix });
  }

  private async writeProfile(): Promise<void> {
    this.onProgress({ stage: "profile", done: 0, total: null });
    const { persona } = this;
    const current = { AINAME: persona.name, SYSTEMPROMPT: persona.systemPrompt, DESCRIPTION: persona.description };
    if (this.pack) {
      const original = await readProfileDocument(this.pack.archive, this.pack.manifest);
      const read = profileText(original, this.pack.manifest);
      const edited = PROFILE_KEYS.filter((key) => current[key] !== read[key]);
      this.changes.profile.edited = edited;
      const document = isObject(original) ? original : { files: {} };
      const ai = isObject(document.ai) ? document.ai : { AIID: persona.id };
      await this.output.document("profile", PROFILE_FILE, { ...document, ai: { ...ai, ...Object.fromEntries(edited.map((key) => [key, current[key]])) } });
      return;
    }
    const files: Record<string, string> = {};
    const ai: Record<string, unknown> = { AIID: persona.id, ...current };
    const avatar = dataUrlBytes(persona.avatarDataUrl);
    if (avatar) {
      const name = imageFileName("avatar", dataUrlMimeType(persona.avatarDataUrl ?? "") ?? "");
      files.AVATAR_IMAGE = `profile/icon/${name}`;
      ai.AVATAR_IMAGE = name;
      await this.output.bytes("profile", files.AVATAR_IMAGE, avatar);
    }
    await this.output.document("profile", PROFILE_FILE, { ai, files });
  }

  private async *indexRows(entries: unknown[]): AsyncGenerator<unknown> {
    if (this.pack && this.declared.has("attachments") && this.pack.archive.has(ATTACHMENT_INDEX_FILE)) yield* this.pack.archive.jsonArray(ATTACHMENT_INDEX_FILE);
    yield* entries;
  }

  /** The images are read back one at a time, after messages.json, which an open entry would block. */
  private async writeImages(): Promise<void> {
    if (this.images.length === 0) return;
    const entries: unknown[] = [];
    for (const [index, image] of this.images.entries()) {
      this.onProgress({ stage: "images", done: index, total: this.images.length });
      const bytes = dataUrlBytes((await this.repository.getMessage(image.messageId))?.metadata.imageDataUrl);
      if (bytes) await this.output.bytes("attachments", image.path, bytes);
      else this.unsavedImages += 1;
      entries.push({
        ref: image.uri, uri: image.uri, original_path: null, mime_type: image.mimeType,
        path: bytes ? image.path : null, summary_path: null, message_ids: [image.messageId], perception_rows: [],
      });
    }
    await this.output.rows("attachments", ATTACHMENT_INDEX_FILE, this.indexRows(entries));
  }

  private async copyTheRest(): Promise<void> {
    if (!this.pack) return;
    const { archive } = this.pack;
    const names = archive.names.filter((name) => name !== MANIFEST_NAME && !this.output.names.has(name));
    for (const [index, name] of names.entries()) {
      this.onProgress({ stage: "files", done: index, total: names.length });
      await archive.copyEntry(name, this.output.zip);
    }
  }

  private async writeManifest(): Promise<void> {
    const original = this.pack ? await this.pack.archive.jsonDocument(MANIFEST_NAME) : null;
    const added = FOLDER_ORDER.filter((folder) => this.output.folders.has(folder) && !this.declared.has(folder));
    await this.output.document("", MANIFEST_NAME, {
      ...(isObject(original) ? original : {}),
      format: FORMAT_NAME,
      version: FORMAT_VERSION,
      generator: { name: GENERATOR_NAME, version: __APP_VERSION__ },
      created_at: epochToIso(Math.floor(Date.now() / 1000)),
      persona_name: this.persona.name,
      persona_id: this.persona.id,
      contents: [...this.declared, ...added],
    });
  }

  async write(): Promise<void> {
    const threads = await this.repository.listThreads(this.personaId);
    await this.writeChatlog(threads);
    await this.writeKnowledge();
    await this.writeFragments();
    await this.writeActiveState(threads);
    await this.writeProfile();
    await this.writeImages();
    await this.output.document(LITE_FOLDER, CHANGES_FILE, this.changes);
    await this.copyTheRest();
    this.onProgress({ stage: "finishing", done: 0, total: null });
    await this.writeManifest();
  }
}

function warningsOf(run: PackExportRun, hasPack: boolean): string[] {
  const warnings: string[] = [];
  if (!hasPack && run.sawSource) warnings.push("元の ZIP がこの端末に無いため、この端末で消した発言とページは本体に伝わりません。本体に残っていたら、本体で消してください。");
  if (run.unsavedImages) warnings.push(`生成した画像 ${run.unsavedImages}件は、この端末に画像そのものが無いので書き出せませんでした。`);
  return warnings;
}

async function runExport(
  personaId: string,
  repository: LiteRepository,
  packStore: PackStore,
  onProgress: (progress: PackExportProgress) => void,
): Promise<PackExportResult> {
  const unavailable = await packStore.unavailableReason();
  if (unavailable) throw new PackError(unavailable);
  const persona = await repository.getPersona(personaId);
  if (!persona) throw new PackError("書き出すパートナーが見つかりません。");
  const session = await repository.getSession(personaId);
  if (session?.importState === "importing") throw new PackError(`${persona.name}の取り込みが途中で止まっています。同じ ZIP で最後まで取り込んでから書き出してください。`);
  const stored = await packStore.get(personaId);
  const free = await packStore.freeBytes();
  if (stored && free !== null && stored.size > free) throw storageShortage(stored.size, free);

  const archive = stored ? await PackArchive.open(stored) : null;
  let work: PackWorkFile | null = null;
  try {
    const pack = archive ? { archive, manifest: await readManifest(archive) } : null;
    work = await packStore.openWork(personaId);
    const zip = new ZipWriter<unknown>(work.writable);
    const run = new PackExportRun(persona, session, repository, pack, new PackOutput(zip, session?.passphrase ?? ""), onProgress);
    await run.write();
    await zip.close();
    const file = await work.file();
    const warnings = warningsOf(run, stored !== null);
    console.log("[SAIVerse Lite][pack] persona exported", { personaId, bytes: file.size, withOriginalZip: stored !== null, created: run.changes.messages.created.length, edited: run.changes.messages.edited.length, deleted: run.changes.messages.deleted.length, warnings: warnings.length });
    return { file, fileName: `${personaId.replace(/[^A-Za-z0-9_.-]/g, "_")}_persona_pack.zip`, changes: run.changes, warnings };
  } catch (error) {
    await work?.abort().catch((abortError: unknown) => console.warn("[SAIVerse Lite][pack] work file could not be dropped", abortError));
    if (error instanceof DOMException && error.name === "QuotaExceededError") throw new PackError("端末の空き容量が足りません。空きを作ってから、もう一度書き出してください。");
    throw error;
  } finally {
    await archive?.close().catch((error: unknown) => console.warn("[SAIVerse Lite][pack] ZIP could not be closed", error));
  }
}

/**
 * Writes a persona back out as a pack: docs/intent/persona_pack.md「Lite から帰るときの合流」.
 * The stored ZIP is the base and the rows Lite holds go over it, so what Lite never read
 * passes through. A persona born here has no ZIP and gets the same files from its rows alone.
 * Reads only: no record of the persona changes. The ZIP stays a work file on disk.
 */
export async function exportPersonaPack(
  personaId: string,
  repository: LiteRepository,
  packStore: PackStore,
  onProgress: (progress: PackExportProgress) => void = () => undefined,
): Promise<PackExportResult> {
  const result = await withOriginLock(EXPORT_LOCK, () => runExport(personaId, repository, packStore, onProgress));
  if (result === "busy") throw new PackError("別の画面で書き出しが進んでいます。終わってから、もう一度押してください。");
  return result;
}
