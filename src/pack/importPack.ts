import type { ChatMessage, ConversationThread, FragmentRecord, PageRecord, Persona, PersonaSession, ToolId } from "../domain";
import { withOriginLock } from "../originLock";
import { createPersonaSession, createTrunkPages, epochSeconds } from "../pageRecords";
import { RowOwnerError, type LiteRepository, type PersonaRecordBatch } from "../storage/repository";
import { PackArchive } from "./archive";
import { PackError, decodeText, isObject, refusedJsonTextColumns } from "./format";
import type { PackStore } from "./packStore";
import { fragmentFromRow, messageFromRow, pageFromRow, threadFromRows, type ThreadSpan } from "./rows";
import {
  ACTIVE_STATE_FILE,
  FRAGMENTS_FILE,
  FRAGMENT_REQUIRED,
  MESSAGES_FILE,
  MESSAGE_JSON_COLUMNS,
  MESSAGE_REQUIRED,
  PAGES_FILE,
  PAGE_JSON_COLUMNS,
  PAGE_REQUIRED,
  PROFILE_FILE,
  STELIS_THREADS_FILE,
  STELIS_THREAD_REQUIRED,
  THREADS_FILE,
  THREAD_REQUIRED,
  checkArchive,
  readManifest,
  type OwnedKeys,
  type PackCheck,
  type PackManifest,
} from "./validate";

const IMPORT_LOCK = "saiverse-lite-pack-import";
const BATCH_ROWS = 300;
/** Rows are held in IndexedDB with their `source` beside them. */
const STORED_BYTES_PER_JSON_BYTE = 2;
const MAX_ICON_BYTES = 2 * 1024 * 1024;
const PERSONA_THREAD_SUFFIX = "__persona__";
const PACK_PERSONA_TOOLS: ToolId[] = ["memory_recall", "memory_read", "memory_write", "image_generate"];

const ICON_TYPES: Record<string, string> = {
  avif: "image/avif", bmp: "image/bmp", gif: "image/gif", jpeg: "image/jpeg", jpg: "image/jpeg",
  png: "image/png", svg: "image/svg+xml", webp: "image/webp",
};

export type PackImportStage = "checking" | "saving" | "messages" | "threads" | "pages" | "fragments" | "finishing";

export interface PackImportProgress {
  stage: PackImportStage;
  done: number;
  /** Null while the row count is not known yet. */
  total: number | null;
}

export interface PackImportOptions {
  providerId: string;
  model: string;
  /** src/memory/window.ts. Reads the session's activeThreadId and returns the anchor message id. */
  resolveInitialAnchor(repository: LiteRepository, personaId: string): Promise<string | null>;
}

export interface PackImportResult {
  personaId: string;
  personaName: string;
  activeThreadId: string | null;
  threads: number;
  messages: number;
  pages: number;
  fragments: number;
  /** What did not come across, for the screen. */
  warnings: string[];
}

interface ProfileFields {
  name: string;
  description: string;
  systemPrompt: string;
  avatarDataUrl: string | null;
}

function bytesToDataUrl(bytes: Uint8Array, type: string): string {
  const pieces: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    pieces.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
  }
  return `data:${type};base64,${btoa(pieces.join(""))}`;
}

async function readIcon(archive: PackArchive, files: unknown, warnings: string[]): Promise<string | null> {
  const name = isObject(files) ? files.AVATAR_IMAGE : null;
  if (typeof name !== "string" || !archive.has(name)) return null;
  const type = ICON_TYPES[name.slice(name.lastIndexOf(".") + 1).toLowerCase()];
  if (!type) {
    warnings.push("アイコンの画像形式に対応していないので、アイコンなしで取り込みました。");
    return null;
  }
  if (archive.size(name) > MAX_ICON_BYTES) {
    warnings.push("アイコンの画像が 2MB を超えていたので、アイコンなしで取り込みました。");
    return null;
  }
  return bytesToDataUrl(await archive.bytes(name), type);
}

async function readProfile(archive: PackArchive, manifest: PackManifest, warnings: string[]): Promise<ProfileFields> {
  const profile = manifest.contents.has("profile") && archive.has(PROFILE_FILE) ? await archive.jsonDocument(PROFILE_FILE) : null;
  const ai = isObject(profile) && isObject(profile.ai) ? profile.ai : {};
  return {
    name: decodeText(ai.AINAME) || manifest.personaName || manifest.personaId,
    description: decodeText(ai.DESCRIPTION),
    systemPrompt: decodeText(ai.SYSTEMPROMPT),
    avatarDataUrl: await readIcon(archive, isObject(profile) ? profile.files : null, warnings),
  };
}

/** body: adapter.py _active_persona_suffix. Only the value is read; a broken file counts as none. */
async function readActiveThreadSuffix(archive: PackArchive, manifest: PackManifest): Promise<string | null> {
  if (!manifest.contents.has("extensions/saiverse") || !archive.has(ACTIVE_STATE_FILE)) return null;
  let state: unknown;
  try {
    state = await archive.jsonDocument(ACTIVE_STATE_FILE);
  } catch (error) {
    console.warn("[SAIVerse Lite][pack] active_state.json could not be read", error);
    return null;
  }
  const values = isObject(state) ? [state.active_thread_id, state.thread_id, state.active_thread] : [state];
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function chooseActiveThread(personaId: string, suffix: string | null, threads: ConversationThread[]): string | null {
  const candidates = threads.filter((thread) => !thread.stelis);
  // The file holds the suffix (`set_active_thread`). The full id is read too, as old data may have it.
  const named = suffix === null ? `${personaId}:${PERSONA_THREAD_SUFFIX}` : suffix.startsWith(`${personaId}:`) ? suffix : `${personaId}:${suffix}`;
  if (candidates.some((thread) => thread.id === named)) return named;
  return candidates.reduce<ConversationThread | null>((latest, thread) => (latest && latest.updatedAt >= thread.updatedAt ? latest : thread), null)?.id ?? null;
}

async function checkStorage(packStore: PackStore, file: Blob, archive: PackArchive): Promise<void> {
  const free = await packStore.freeBytes();
  if (free === null) return;
  const jsonBytes = archive.size(MESSAGES_FILE) + archive.size(PAGES_FILE) + archive.size(FRAGMENTS_FILE);
  const needed = file.size + jsonBytes * STORED_BYTES_PER_JSON_BYTE;
  if (needed > free) {
    const megabytes = (bytes: number) => Math.ceil(bytes / (1024 * 1024));
    throw new PackError(`端末の空き容量が足りません。約 ${megabytes(needed)}MB 必要ですが、使えるのは約 ${megabytes(free)}MB です。`);
  }
}

async function ownerRefusal(repository: LiteRepository, owner: string): Promise<PackError> {
  const name = (await repository.getPersona(owner))?.name ?? owner;
  return new PackError(`このパックの会話は、すでにこの端末にいる${name}の会話と重なっています。入れ直すときは、先に${name}を削除してください。`);
}

/**
 * Messages and threads are stored by their id alone, and the body keeps message ids when it
 * gives a persona a new persona_id. Writing such a pack would take the rows from the persona
 * already here, so it is refused before anything is written. `writePersonaRecords` holds the
 * same rule inside each write's transaction.
 */
async function refuseRowsOfAnotherPersona(repository: LiteRepository, personaId: string, keys: OwnedKeys): Promise<void> {
  const threadIds = [...new Set(keys.threadIds)];
  const [messages, threads] = await Promise.all([
    Promise.all(keys.messageIds.map((id) => repository.getMessage(id))),
    Promise.all(threadIds.map((id) => repository.getThread(id))),
  ]);
  const owner = [...messages, ...threads].find((row) => row && row.personaId !== personaId)?.personaId;
  if (owner !== undefined) throw await ownerRefusal(repository, owner);
}

function refusalWarnings({ refused }: PackCheck): string[] {
  const warnings: string[] = [];
  if (refused.messages) warnings.push(`発言 ${refused.messages}件は記録が壊れていたので、取り込みませんでした。`);
  if (refused.pages) warnings.push(`記憶のページ ${refused.pages}件は記録が壊れていたので、取り込みませんでした。`);
  return warnings;
}

class BatchWriter<Row> {
  private rows: Row[] = [];
  written = 0;

  constructor(
    private readonly write: (rows: Row[]) => Promise<void>,
    private readonly onWritten: (written: number) => void,
  ) {}

  async add(row: Row): Promise<void> {
    this.rows.push(row);
    if (this.rows.length >= BATCH_ROWS) await this.flush();
  }

  async flush(): Promise<void> {
    if (this.rows.length === 0) return;
    await this.write(this.rows);
    this.written += this.rows.length;
    this.rows = [];
    this.onWritten(this.written);
  }
}

async function writeRecords(
  archive: PackArchive,
  repository: LiteRepository,
  personaId: string,
  check: PackCheck,
  nowMs: number,
  onProgress: (progress: PackImportProgress) => void,
): Promise<{ threads: ConversationThread[]; messages: number; pages: number; fragments: number }> {
  const { counts, manifest } = check;
  const has = (folder: string) => manifest.contents.has(folder);

  const threadRows = new Map<string, Record<string, unknown>>();
  const stelisRows = new Map<string, Record<string, unknown>>();
  const spans = new Map<string, ThreadSpan>();
  if (has("chatlog")) {
    for await (const row of archive.rows(THREADS_FILE, THREAD_REQUIRED)) threadRows.set(String(row.id), row);
    for await (const row of archive.rows(STELIS_THREADS_FILE, STELIS_THREAD_REQUIRED)) stelisRows.set(String(row.thread_id), row);
  }

  const writeBatch = async (batch: PersonaRecordBatch): Promise<void> => {
    try {
      await repository.writePersonaRecords(personaId, batch);
    } catch (error) {
      throw error instanceof RowOwnerError ? await ownerRefusal(repository, error.ownerPersonaId) : error;
    }
  };
  const messages = new BatchWriter<ChatMessage>((rows) => writeBatch({ messages: rows }), (done) => onProgress({ stage: "messages", done, total: counts.messages }));
  if (has("chatlog")) {
    let ordinal = 0;
    for await (const row of archive.rows(MESSAGES_FILE, MESSAGE_REQUIRED)) {
      ordinal += 1;
      if (refusedJsonTextColumns(row, MESSAGE_JSON_COLUMNS).length) continue;
      const message = messageFromRow(row, personaId, ordinal);
      const span = spans.get(message.threadId);
      if (span) {
        span.firstMs = Math.min(span.firstMs, message.createdAt);
        span.lastMs = Math.max(span.lastMs, message.createdAt);
      } else {
        spans.set(message.threadId, { firstMs: message.createdAt, lastMs: message.createdAt });
      }
      await messages.add(message);
    }
    await messages.flush();
  }

  const threadIds = new Set([...threadRows.keys(), ...stelisRows.keys(), ...spans.keys()]);
  const threads = [...threadIds].map((id) => threadFromRows(id, personaId, threadRows.get(id), stelisRows.get(id), spans.get(id), nowMs));
  const threadWriter = new BatchWriter<ConversationThread>((rows) => writeBatch({ threads: rows }), (done) => onProgress({ stage: "threads", done, total: threads.length }));
  for (const thread of threads) await threadWriter.add(thread);
  await threadWriter.flush();

  const pageIds = new Set<string>();
  const pages = new BatchWriter<PageRecord>((rows) => writeBatch({ pages: rows }), (done) => onProgress({ stage: "pages", done, total: counts.pages }));
  if (has("knowledge")) {
    for await (const row of archive.rows(PAGES_FILE, PAGE_REQUIRED)) {
      if (refusedJsonTextColumns(row, PAGE_JSON_COLUMNS).length) continue;
      const page = pageFromRow(row, personaId);
      pageIds.add(page.id);
      await pages.add(page);
    }
    await pages.flush();
  }

  // An older pack can lack a trunk. Its number comes after the pack's, which keep their references.
  let nextShortId = await repository.nextPageShortId(personaId);
  for (const trunk of createTrunkPages(personaId, epochSeconds(nowMs))) {
    if (pageIds.has(trunk.id) || await repository.getPage(personaId, trunk.id)) continue;
    const shortId = trunk.shortId === null ? null : nextShortId++;
    await repository.putPage({ ...trunk, shortId });
  }

  const fragments = new BatchWriter<FragmentRecord>((rows) => writeBatch({ fragments: rows }), (done) => onProgress({ stage: "fragments", done, total: counts.fragments }));
  if (has("extensions/saiverse")) {
    for await (const row of archive.rows(FRAGMENTS_FILE, FRAGMENT_REQUIRED)) {
      await fragments.add(fragmentFromRow(row, personaId));
    }
    await fragments.flush();
  }
  return { threads, messages: messages.written, pages: pages.written, fragments: fragments.written };
}

/**
 * Brings a body persona into Lite: docs/memory_core.md「パックの取り込み」. Nothing is written
 * until the whole pack has passed the checks. The session says `importing` from the first
 * write on, so a stop leaves a persona that cannot be talked to, and choosing the same ZIP
 * again replaces every row by its ID and finishes. One import runs at a time in this origin.
 */
export async function importPersonaPack(
  file: Blob,
  repository: LiteRepository,
  packStore: PackStore,
  options: PackImportOptions,
  onProgress: (progress: PackImportProgress) => void = () => undefined,
): Promise<PackImportResult> {
  const result = await withOriginLock(IMPORT_LOCK, () => runImport(file, repository, packStore, options, onProgress));
  if (result === "busy") throw new PackError("別の画面で取り込みが進んでいます。終わってから、もう一度選んでください。");
  return result;
}

async function runImport(
  file: Blob,
  repository: LiteRepository,
  packStore: PackStore,
  options: PackImportOptions,
  onProgress: (progress: PackImportProgress) => void,
): Promise<PackImportResult> {
  const unavailable = await packStore.unavailableReason();
  if (unavailable) throw new PackError(unavailable);

  onProgress({ stage: "checking", done: 0, total: null });
  const archive = await PackArchive.open(file);
  try {
    const manifest = await readManifest(archive);
    const personaId = manifest.personaId;
    const existingPersona = await repository.getPersona(personaId);
    const existingSession = await repository.getSession(personaId);
    const resuming = existingSession?.importState === "importing";
    if (existingPersona && !resuming) throw new PackError(`${existingPersona.name}はすでにこの端末にいます。入れ直すときは、先にパートナーを削除してください。`);
    const importFingerprint = await archive.fingerprint();
    if (resuming && existingSession?.importFingerprint !== importFingerprint) {
      throw new PackError(`${existingPersona?.name ?? personaId}の取り込みは別の ZIP で途中まで進んでいます。同じ ZIP を選ぶか、先にパートナーを削除してください。`);
    }

    const check = await checkArchive(archive, manifest, {
      onRows: (done) => onProgress({ stage: "checking", done, total: null }),
      onOwnedKeys: (keys) => refuseRowsOfAnotherPersona(repository, personaId, keys),
    });
    const warnings = refusalWarnings(check);
    const profile = await readProfile(archive, manifest, warnings);

    onProgress({ stage: "saving", done: 0, total: null });
    const stored = resuming ? await packStore.get(personaId) : null;
    if (!resuming) await checkStorage(packStore, file, archive);
    if (!stored) await packStore.put(personaId, file);

    const nowMs = Date.now();
    // The session comes first: with it in place, putPersona leaves the trunk pages to this import.
    const session: PersonaSession = { ...(existingSession ?? createPersonaSession(personaId)), importState: "importing", importFingerprint };
    await repository.putSession(session);
    const persona: Persona = {
      id: personaId,
      ...profile,
      providerId: options.providerId,
      model: options.model,
      toolIds: PACK_PERSONA_TOOLS,
      createdAt: existingPersona?.createdAt ?? nowMs,
      updatedAt: nowMs,
    };
    await repository.putPersona(persona);

    const written = await writeRecords(archive, repository, personaId, check, nowMs, onProgress);

    onProgress({ stage: "finishing", done: 0, total: null });
    const activeThreadId = chooseActiveThread(personaId, await readActiveThreadSuffix(archive, manifest), written.threads);
    await repository.putSession({ ...session, activeThreadId });
    const anchorMessageId = await options.resolveInitialAnchor(repository, personaId);
    await repository.putSession({ ...session, activeThreadId, anchorMessageId, importState: "ready" });

    console.log("[SAIVerse Lite][pack] persona imported", { personaId, threads: written.threads.length, messages: written.messages, pages: written.pages, fragments: written.fragments, activeThreadId, anchorMessageId, warnings: warnings.length });
    return {
      personaId,
      personaName: persona.name,
      activeThreadId,
      threads: written.threads.length,
      messages: written.messages,
      pages: written.pages,
      fragments: written.fragments,
      warnings,
    };
  } finally {
    await archive.close().catch((error: unknown) => console.warn("[SAIVerse Lite][pack] ZIP could not be closed", error));
  }
}
