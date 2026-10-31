import { PackArchive } from "./archive";
import { isObject } from "./format";
import type { PackStore } from "./packStore";
import { ATTACHMENT_INDEX_FILE } from "./validate";

/** One item of `metadata.images` / `documents` / `media` on a message row. */
export interface AttachmentItem {
  uri?: unknown;
  path?: unknown;
}

interface OpenPack {
  size: number;
  lastModified: number | undefined;
  opened: Promise<{ archive: PackArchive; byRef: Map<string, { path: string; mimeType: string }> }>;
}

const openPacks = new Map<string, OpenPack>();

// body: export.py _attachment_key. `ref` of attachments/index.json is the same key.
function attachmentKey(item: AttachmentItem): string | null {
  if (typeof item.uri === "string" && item.uri.trim()) return item.uri.trim();
  if (typeof item.path === "string" && item.path.trim()) return item.path.trim();
  return null;
}

async function openAttachments(file: Blob): Promise<Awaited<OpenPack["opened"]>> {
  const archive = await PackArchive.open(file);
  const byRef = new Map<string, { path: string; mimeType: string }>();
  if (archive.has(ATTACHMENT_INDEX_FILE)) {
    for await (const entry of archive.jsonArray(ATTACHMENT_INDEX_FILE)) {
      if (!isObject(entry) || typeof entry.ref !== "string" || typeof entry.path !== "string") continue;
      byRef.set(entry.ref, { path: entry.path, mimeType: typeof entry.mime_type === "string" ? entry.mime_type : "" });
    }
  }
  return { archive, byRef };
}

function openedPack(personaId: string, file: Blob): OpenPack["opened"] {
  const lastModified = file instanceof File ? file.lastModified : undefined;
  const current = openPacks.get(personaId);
  if (current && current.size === file.size && current.lastModified === lastModified) return current.opened;
  void current?.opened.then(({ archive }) => archive.close()).catch(() => undefined);
  const opened = openAttachments(file);
  openPacks.set(personaId, { size: file.size, lastModified, opened });
  opened.catch(() => openPacks.delete(personaId));
  return opened;
}

/**
 * The file a message's `metadata` item points to, read out of the persona's stored ZIP.
 * Null when the persona has no stored pack or the export could not carry the file.
 */
export async function readAttachment(packStore: PackStore, personaId: string, item: AttachmentItem): Promise<Blob | null> {
  const key = attachmentKey(item);
  if (key === null) return null;
  const file = await packStore.get(personaId);
  if (!file) return null;
  const { archive, byRef } = await openedPack(personaId, file);
  const entry = byRef.get(key);
  return entry ? archive.blob(entry.path, entry.mimeType) : null;
}
