import { PackArchive } from "./archive";
import { FORMAT_NAME, MANIFEST_NAME, MAX_UNCOMPRESSED_BYTES, PackError, isObject, refusedJsonTextColumns } from "./format";

export const THREADS_FILE = "chatlog/threads.json";
export const STELIS_THREADS_FILE = "chatlog/stelis_threads.json";
export const MESSAGES_FILE = "chatlog/messages.json";
export const PAGES_FILE = "knowledge/pages.json";
export const FRAGMENTS_FILE = "extensions/saiverse/memory_db/memopedia_fragments.json";
export const PROFILE_FILE = "profile/profile.json";
export const ACTIVE_STATE_FILE = "extensions/saiverse/persona_dir/active_state.json";
export const ATTACHMENT_INDEX_FILE = "attachments/index.json";

/** body: export.py JSON_TEXT_COLUMNS. */
export const MESSAGE_JSON_COLUMNS = ["metadata"] as const;
export const PAGE_JSON_COLUMNS = ["metadata", "keywords"] as const;

const EXTENSION_TABLE_FOLDERS = ["extensions/saiverse/memory_db/", "extensions/saiverse/saiverse_db/"];
const TABLE_FILE_PATTERN = /^[A-Za-z0-9_]+\.json$/;

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
  /** Rows the import leaves out: the same refusal as the body's, one line each. */
  refused: string[];
}

export type RowProgress = (rowsRead: number) => void;

/** body: importer.py _safe_relpath. */
export function isSafeRelativePath(path: string): boolean {
  if (!path || path.includes("\\") || path.includes(":") || path.startsWith("/")) return false;
  return path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

/** The manifest checks of body importer.py _load_pack, and nothing past them. */
export async function readManifest(archive: PackArchive): Promise<PackManifest> {
  if (!archive.has(MANIFEST_NAME)) throw new PackError("パックに manifest.json がありません");
  const manifest = await archive.jsonDocument(MANIFEST_NAME);
  if (!isObject(manifest) || manifest.format !== FORMAT_NAME) throw new PackError("ペルソナのパックではありません");
  const version = String(manifest.version || "");
  if (version.split(".", 1)[0] !== "1") throw new PackError(`対応していないパックの版です: ${version}`);
  const personaId = manifest.persona_id;
  if (typeof personaId !== "string" || !personaId) throw new PackError("manifest.json に persona_id がありません");
  const contents = manifest.contents;
  if (!Array.isArray(contents) || !contents.every((item) => typeof item === "string")) throw new PackError("manifest.json の contents が不正です");
  return {
    personaId,
    personaName: typeof manifest.persona_name === "string" ? manifest.persona_name : null,
    createdAt: typeof manifest.created_at === "string" ? manifest.created_at : null,
    contents: new Set(contents as string[]),
  };
}

function checkListing(archive: PackArchive, manifest: PackManifest): void {
  if (archive.uncompressedBytes > MAX_UNCOMPRESSED_BYTES) throw new PackError("展開後の大きさが上限を超えています");
  for (const name of archive.names) {
    if (!isSafeRelativePath(name)) throw new PackError(`パックの中に安全でないパスがあります: ${name}`);
  }
  if (!manifest.contents.has("extensions/saiverse")) return;
  for (const name of archive.names) {
    const folder = EXTENSION_TABLE_FOLDERS.find((prefix) => name.startsWith(prefix));
    if (folder && !TABLE_FILE_PATTERN.test(name.slice(folder.length))) throw new PackError(`extensions の中に想定外のファイルがあります: ${name}`);
  }
}

async function checkAttachmentIndex(archive: PackArchive): Promise<void> {
  let index = 0;
  for await (const entry of archive.jsonArray(ATTACHMENT_INDEX_FILE)) {
    if (!isObject(entry)) throw new PackError(`${ATTACHMENT_INDEX_FILE} の ${index + 1} 番目の要素がオブジェクトではありません`);
    const path = entry.path;
    if (path !== null && path !== undefined) {
      if (typeof path !== "string" || !archive.has(path)) throw new PackError(`${ATTACHMENT_INDEX_FILE} の ${index + 1} 番目が無いファイルを指しています`);
      const parts = path.split("/");
      if (parts.length !== 3 || parts[0] !== "attachments" || !isSafeRelativePath(path)) throw new PackError(`添付のパスが不正です: ${path}`);
    }
    index += 1;
  }
}

async function checkProfile(archive: PackArchive): Promise<void> {
  const profile = await archive.jsonDocument(PROFILE_FILE);
  if (!isObject(profile) || !isObject(profile.ai)) throw new PackError(`${PROFILE_FILE} に ai がありません`);
}

function refusalLine(name: string, row: Record<string, unknown>, columns: string[]): string {
  return `${name} (id=${String(row.id)}): ${columns.join(", ")} が不正なので取り込みません`;
}

/**
 * body: importer.py validate_pack, for what Lite reads: chatlog, knowledge, attachments/index.json,
 * profile and memopedia_fragments are parsed in full. Of the folders Lite leaves in the ZIP
 * (journal, items, the rest of extensions), only the file listing is checked.
 */
export async function checkArchive(archive: PackArchive, manifest: PackManifest, onRows?: RowProgress): Promise<PackCheck> {
  checkListing(archive, manifest);
  const counts: PackRowCounts = { messages: 0, pages: 0, fragments: 0 };
  const refused: string[] = [];
  let read = 0;
  const seen = () => {
    read += 1;
    if (read % 500 === 0) onRows?.(read);
  };
  const has = (folder: string) => manifest.contents.has(folder);
  if (has("chatlog")) {
    for await (const row of archive.rows(THREADS_FILE, ["id"])) { void row; seen(); }
    for await (const row of archive.rows(STELIS_THREADS_FILE, ["thread_id"])) { void row; seen(); }
    for await (const row of archive.rows(MESSAGES_FILE, ["id", "thread_id"])) {
      const columns = refusedJsonTextColumns(row, MESSAGE_JSON_COLUMNS);
      if (columns.length) refused.push(refusalLine(MESSAGES_FILE, row, columns));
      else counts.messages += 1;
      seen();
    }
  }
  if (has("knowledge")) {
    for await (const row of archive.rows(PAGES_FILE, ["id", "category"])) {
      const columns = refusedJsonTextColumns(row, PAGE_JSON_COLUMNS);
      if (columns.length) refused.push(refusalLine(PAGES_FILE, row, columns));
      else counts.pages += 1;
      seen();
    }
  }
  if (has("attachments") && archive.has(ATTACHMENT_INDEX_FILE)) await checkAttachmentIndex(archive);
  if (has("profile") && archive.has(PROFILE_FILE)) await checkProfile(archive);
  if (has("extensions/saiverse")) {
    for await (const row of archive.rows(FRAGMENTS_FILE, ["id", "content", "entity_id", "created_at"])) {
      void row;
      counts.fragments += 1;
      seen();
    }
  }
  return { manifest, counts, refused };
}

/** Checks a pack without writing anything. Throws PackError on the first refusal. */
export async function validatePack(file: Blob, onRows?: RowProgress): Promise<PackCheck> {
  const archive = await PackArchive.open(file);
  try {
    return await checkArchive(archive, await readManifest(archive), onRows);
  } finally {
    await archive.close();
  }
}
