import { PackArchive } from "./archive";
import { FORMAT_NAME, MANIFEST_NAME, MAX_UNCOMPRESSED_BYTES, PackError, PackFormatError, isObject, refusedJsonTextColumns } from "./format";

export const THREADS_FILE = "chatlog/threads.json";
export const STELIS_THREADS_FILE = "chatlog/stelis_threads.json";
export const MESSAGES_FILE = "chatlog/messages.json";
export const PAGES_FILE = "knowledge/pages.json";
export const FRAGMENTS_FILE = "extensions/saiverse/memory_db/memopedia_fragments.json";
export const PROFILE_FILE = "profile/profile.json";
export const ACTIVE_STATE_FILE = "extensions/saiverse/persona_dir/active_state.json";
export const ATTACHMENT_INDEX_FILE = "attachments/index.json";
const PRIVATE_ROOM_FILE = "items/private_room.json";
const ITEMS_FILE = "items/items.json";

/** body: export.py JSON_TEXT_COLUMNS. */
export const MESSAGE_JSON_COLUMNS = ["metadata"] as const;
export const PAGE_JSON_COLUMNS = ["metadata", "keywords"] as const;

export const THREAD_REQUIRED = ["id"] as const;
export const STELIS_THREAD_REQUIRED = ["thread_id"] as const;
export const MESSAGE_REQUIRED = ["id", "thread_id"] as const;
export const PAGE_REQUIRED = ["id", "category"] as const;
/** The body does not check this table, but its columns are NOT NULL. `content` can be empty. */
export const FRAGMENT_REQUIRED = ["id", "entity_id", "created_at"] as const;

/** body: importer.py _load_pack, the "journal" branch. */
const JOURNAL_TABLES: [string, string][] = [
  ["journal/activities.json", "id"],
  ["journal/memos.json", "activity_id"],
  ["journal/clips.json", "clip_id"],
  ["journal/purpose_tags.json", "tag_id"],
  ["journal/task_book.json", "TASK_ID"],
];

const EXTENSION_TABLE_FOLDERS = ["extensions/saiverse/memory_db/", "extensions/saiverse/saiverse_db/"];
const TABLE_FILE_PATTERN = /^[A-Za-z0-9_]+\.json$/;
const OWNER_CHECK_ROWS = 300;

export interface PackManifest {
  personaId: string;
  personaName: string | null;
  createdAt: string | null;
  contents: Set<string>;
}

export interface PackRowCounts {
  messages: number;
  pages: number;
  fragments: number;
}

export interface PackCheck {
  manifest: PackManifest;
  counts: PackRowCounts;
  /** Rows the import leaves out: the same refusal as the body's. */
  refused: { messages: number; pages: number };
}

export type RowProgress = (rowsRead: number) => void;

/** The ids in a pack that are unique across personas once stored. */
export interface OwnedKeys {
  threadIds: string[];
  messageIds: string[];
}

export interface PackCheckHooks {
  onRows?: RowProgress;
  /** After each part of the pack: `done` of `total` parts are checked. */
  onStep?: (done: number, total: number) => void;
  /** Sees the id of every thread and message row, some hundreds at a time. A throw refuses the pack. */
  onOwnedKeys?: (keys: OwnedKeys) => Promise<void>;
}

/** body: importer.py _safe_relpath. */
export function isSafeRelativePath(path: string): boolean {
  if (!path || path.includes("\\") || path.includes(":") || path.startsWith("/")) return false;
  return path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

/** The manifest checks of body importer.py _load_pack, and nothing past them. */
export async function readManifest(archive: PackArchive): Promise<PackManifest> {
  if (!archive.has(MANIFEST_NAME)) throw new PackFormatError("パックに manifest.json がありません");
  const manifest = await archive.jsonDocument(MANIFEST_NAME);
  if (!isObject(manifest) || manifest.format !== FORMAT_NAME) throw new PackFormatError("ペルソナのパックではありません");
  const version = String(manifest.version || "");
  if (version.split(".", 1)[0] !== "1") {
    console.warn("[SAIVerse Lite][pack] unsupported pack version", version);
    throw new PackError("対応していない版のパックです。SAIVerse Lite を更新してから、選び直してください。");
  }
  const personaId = manifest.persona_id;
  if (typeof personaId !== "string" || !personaId) throw new PackFormatError("manifest.json に persona_id がありません");
  const contents = manifest.contents;
  if (!Array.isArray(contents) || !contents.every((item) => typeof item === "string")) throw new PackFormatError("manifest.json の contents が不正です");
  return {
    personaId,
    personaName: typeof manifest.persona_name === "string" ? manifest.persona_name : null,
    createdAt: typeof manifest.created_at === "string" ? manifest.created_at : null,
    contents: new Set(contents as string[]),
  };
}

function extensionTableFolder(name: string): string | undefined {
  return EXTENSION_TABLE_FOLDERS.find((folder) => name.startsWith(folder));
}

function checkListing(archive: PackArchive, manifest: PackManifest): void {
  if (archive.uncompressedBytes > MAX_UNCOMPRESSED_BYTES) throw new PackFormatError("展開後の大きさが上限を超えています");
  for (const name of archive.names) {
    if (!isSafeRelativePath(name)) throw new PackFormatError(`パックの中に安全でないパスがあります: ${name}`);
  }
  if (!manifest.contents.has("extensions/saiverse")) return;
  for (const name of archive.names) {
    const folder = extensionTableFolder(name);
    if (folder && !TABLE_FILE_PATTERN.test(name.slice(folder.length))) throw new PackFormatError(`extensions の中に想定外のファイルがあります: ${name}`);
  }
}

async function checkAttachmentIndex(archive: PackArchive): Promise<void> {
  let index = 0;
  for await (const entry of archive.jsonArray(ATTACHMENT_INDEX_FILE)) {
    if (!isObject(entry)) throw new PackFormatError(`${ATTACHMENT_INDEX_FILE} の ${index + 1} 番目の要素がオブジェクトではありません`);
    const path = entry.path;
    if (path !== null && path !== undefined) {
      if (typeof path !== "string" || !archive.has(path)) throw new PackFormatError(`${ATTACHMENT_INDEX_FILE} の ${index + 1} 番目が無いファイルを指しています`);
      const parts = path.split("/");
      if (parts.length !== 3 || parts[0] !== "attachments" || !isSafeRelativePath(path)) throw new PackFormatError(`添付のパスが不正です: ${path}`);
    }
    index += 1;
  }
}

async function checkProfile(archive: PackArchive): Promise<void> {
  const profile = await archive.jsonDocument(PROFILE_FILE);
  if (!isObject(profile) || !isObject(profile.ai)) throw new PackFormatError(`${PROFILE_FILE} に ai がありません`);
}

/** body: importer.py _check_zip_file_ref. The listing has already judged the path itself. */
function checkItemFile(archive: PackArchive, value: unknown, where: string): void {
  if (value === null || value === undefined) return;
  if (typeof value !== "string" || !archive.has(value) || !value.startsWith("items/")) throw new PackFormatError(`${where} が無いファイルを指しています`);
}

function nonEmptyText(value: unknown): boolean {
  return typeof value === "string" && value !== "";
}

/** body: importer.py _load_items. */
async function checkItems(archive: PackArchive): Promise<void> {
  if (archive.has(PRIVATE_ROOM_FILE)) {
    const room = await archive.jsonDocument(PRIVATE_ROOM_FILE);
    const fixtures = isObject(room) && room.fixtures !== undefined ? room.fixtures : [];
    const files = isObject(room) ? room.files || {} : null;
    if (!isObject(room) || !isObject(room.building) || !Array.isArray(fixtures) || !fixtures.every(isObject) || !isObject(files)) {
      throw new PackFormatError(`${PRIVATE_ROOM_FILE} に building か fixtures がありません`);
    }
    checkItemFile(archive, files.IMAGE_PATH, `${PRIVATE_ROOM_FILE} の IMAGE_PATH`);
    const fixtureFiles = files.fixtures || {};
    if (!isObject(fixtureFiles)) throw new PackFormatError(`${PRIVATE_ROOM_FILE} の files.fixtures が不正です`);
    for (const [key, value] of Object.entries(fixtureFiles)) checkItemFile(archive, value, `${PRIVATE_ROOM_FILE} の ${key}`);
    fixtures.forEach((fixture, index) => {
      if (!nonEmptyText(fixture.FIXTURE_ID)) throw new PackFormatError(`${PRIVATE_ROOM_FILE} の fixtures の ${index + 1} 番目に FIXTURE_ID がありません`);
    });
  }
  if (archive.has(ITEMS_FILE)) {
    const document = await archive.jsonDocument(ITEMS_FILE);
    const files = isObject(document) ? document.files || {} : null;
    if (!isObject(document) || !Array.isArray(document.items) || !Array.isArray(document.locations) || !isObject(files)) {
      throw new PackFormatError(`${ITEMS_FILE} に items か locations がありません`);
    }
    document.items.forEach((item: unknown, index) => {
      if (!isObject(item) || !nonEmptyText(item.ITEM_ID)) throw new PackFormatError(`${ITEMS_FILE} の items の ${index + 1} 番目に ITEM_ID がありません`);
    });
    document.locations.forEach((location: unknown, index) => {
      if (!isObject(location) || !["ITEM_ID", "OWNER_KIND", "OWNER_ID"].every((key) => nonEmptyText(location[key]))) {
        throw new PackFormatError(`${ITEMS_FILE} の locations の ${index + 1} 番目が不正です`);
      }
    });
    for (const [key, value] of Object.entries(files)) checkItemFile(archive, value, `${ITEMS_FILE} の ${key}`);
  }
}

/**
 * body: importer.py validate_pack, the same conditions. Lite stores only part of what it checks:
 * the ZIP stays as it is and goes back to the body one day, so a pack the body would refuse is
 * refused here too, also over a folder Lite never reads.
 */
export async function checkArchive(archive: PackArchive, manifest: PackManifest, hooks: PackCheckHooks = {}): Promise<PackCheck> {
  checkListing(archive, manifest);
  const counts: PackRowCounts = { messages: 0, pages: 0, fragments: 0 };
  const refused = { messages: 0, pages: 0 };
  let read = 0;
  const seen = () => {
    read += 1;
    if (read % 500 === 0) hooks.onRows?.(read);
  };
  const has = (folder: string) => manifest.contents.has(folder);
  const checksAttachments = has("attachments") && archive.has(ATTACHMENT_INDEX_FILE);
  const checksProfile = has("profile") && archive.has(PROFILE_FILE);
  const extensionTables = has("extensions/saiverse") ? archive.names.filter(extensionTableFolder) : [];
  const stepsTotal = (has("chatlog") ? 3 : 0) + (has("knowledge") ? 1 : 0) + (has("journal") ? JOURNAL_TABLES.length : 0)
    + (checksAttachments ? 1 : 0) + (checksProfile ? 1 : 0) + (has("items") ? 1 : 0) + extensionTables.length;
  let stepsDone = 0;
  const step = () => {
    stepsDone += 1;
    hooks.onStep?.(stepsDone, stepsTotal);
  };
  if (has("chatlog")) {
    let keys: OwnedKeys = { threadIds: [], messageIds: [] };
    const flushKeys = async (): Promise<void> => {
      await hooks.onOwnedKeys?.(keys);
      keys = { threadIds: [], messageIds: [] };
    };
    const flushFullKeys = async (): Promise<void> => {
      if (keys.threadIds.length + keys.messageIds.length >= OWNER_CHECK_ROWS) await flushKeys();
    };
    for await (const row of archive.rows(THREADS_FILE, THREAD_REQUIRED)) {
      keys.threadIds.push(String(row.id));
      await flushFullKeys();
      seen();
    }
    step();
    for await (const row of archive.rows(STELIS_THREADS_FILE, STELIS_THREAD_REQUIRED)) {
      keys.threadIds.push(String(row.thread_id));
      await flushFullKeys();
      seen();
    }
    step();
    for await (const row of archive.rows(MESSAGES_FILE, MESSAGE_REQUIRED)) {
      const columns = refusedJsonTextColumns(row, MESSAGE_JSON_COLUMNS);
      if (columns.length) {
        console.warn("[SAIVerse Lite][pack] message left out", { id: row.id, columns });
        refused.messages += 1;
      } else {
        counts.messages += 1;
      }
      keys.threadIds.push(String(row.thread_id));
      keys.messageIds.push(String(row.id));
      await flushFullKeys();
      seen();
    }
    await flushKeys();
    step();
  }
  if (has("knowledge")) {
    for await (const row of archive.rows(PAGES_FILE, PAGE_REQUIRED)) {
      const columns = refusedJsonTextColumns(row, PAGE_JSON_COLUMNS);
      if (columns.length) {
        console.warn("[SAIVerse Lite][pack] page left out", { id: row.id, columns });
        refused.pages += 1;
      } else {
        counts.pages += 1;
      }
      seen();
    }
    step();
  }
  if (has("journal")) {
    for (const [name, key] of JOURNAL_TABLES) {
      for await (const row of archive.rows(name, [key])) { void row; seen(); }
      step();
    }
  }
  if (checksAttachments) {
    await checkAttachmentIndex(archive);
    step();
  }
  if (checksProfile) {
    await checkProfile(archive);
    step();
  }
  if (has("items")) {
    await checkItems(archive);
    step();
  }
  for (const name of extensionTables) {
    const isFragments = name === FRAGMENTS_FILE;
    for await (const row of archive.rows(name, isFragments ? FRAGMENT_REQUIRED : [])) {
      void row;
      if (isFragments) counts.fragments += 1;
      seen();
    }
    step();
  }
  return { manifest, counts, refused };
}

/** Checks a pack without writing anything. Throws PackError on the first refusal. */
export async function validatePack(file: Blob, onRows?: RowProgress): Promise<PackCheck> {
  const archive = await PackArchive.open(file);
  try {
    return await checkArchive(archive, await readManifest(archive), onRows ? { onRows } : {});
  } finally {
    await archive.close();
  }
}
