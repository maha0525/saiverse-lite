import type { ChatMessage } from "../domain";
import type { ProviderMessage } from "../llm/types";
import { formatTimestampSeconds } from "./entries";
import { noticeMessage, redactPassphrase } from "./notices";

const WEEKDAY_NAMES = ["日", "月", "火", "水", "木", "金", "土"];

function imageEntries(metadata: Record<string, unknown>): Array<Record<string, unknown>> {
  const media = Array.isArray(metadata.media) ? metadata.media : [];
  const images = Array.isArray(metadata.images) ? metadata.images : [];
  const items = [
    ...media.filter((item) => {
      if (typeof item !== "object" || item === null) return false;
      const { type, mime_type: mime } = item as Record<string, unknown>;
      return type ? String(type).toLowerCase() === "image" : String(mime ?? "").toLowerCase().startsWith("image/");
    }),
    ...images.filter((item) => typeof item === "object" && item !== null),
  ] as Array<Record<string, unknown>>;
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = String(item.uri ?? item.path ?? "");
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** body: llm_clients/system_notice.py `system_notice_media_note`, fixed by the row so the same record sends the same text. */
function imageNotes(metadata: Record<string, unknown>): string[] {
  return imageEntries(metadata).map((item) => {
    const uri = String(item.uri ?? item.path);
    const summary = typeof item.summary === "string" ? item.summary.trim() : "";
    return summary ? `[画像: ${uri}] ${summary}` : `[画像: ${uri}]`;
  });
}

function withImageNotes(text: string, message: ChatMessage): string {
  return [text, ...imageNotes(message.metadata)].filter(Boolean).join("\n");
}

/** body: sea/runtime_context.py `_reframe_autonomous_messages`. */
function autonomousRecord(content: string): string {
  return `[自律行動の記録]\nあなたは自律的に以下の行動を取りました：\n\`\`\`\n${content}\n\`\`\``;
}

/** Stored rows in the form every provider receives. Nothing here is written back to a row. */
export function presentRows(rows: ChatMessage[], passphrase: string): ProviderMessage[] {
  const messages: ProviderMessage[] = [];
  for (const row of rows) {
    // body: saiverse_memory/adapter.py `_expand_paired_action_payloads`.
    if (row.pairedActionText) messages.push(noticeMessage(row.pairedActionText, passphrase));
    if (row.role === "system" || row.role === "host") {
      messages.push(noticeMessage(withImageNotes(row.content, row), passphrase));
    } else if (row.role === "assistant" && row.metadata.aspect === "autonomous") {
      messages.push(noticeMessage(autonomousRecord(row.content), passphrase));
    } else {
      messages.push({
        role: row.role,
        content: redactPassphrase(withImageNotes(row.content, row), passphrase),
        toolCallId: null,
        toolName: null,
        toolCalls: [],
      });
    }
  }
  return messages;
}

/** body: sea/runtime_context.py `_append_history`, "時刻アンカー". */
export function timeOriginNotice(rows: ChatMessage[], passphrase: string): ProviderMessage[] {
  const oldest = rows[0];
  if (!oldest) return [];
  const text = formatTimestampSeconds(Math.floor(oldest.createdAt / 1000));
  return [noticeMessage(`以下、${text} 以降のやり取りです`, passphrase)];
}

/** body: sea/runtime.py `_build_realtime_context`, with AI.REALTIME_LAST_UTTERANCE_ENABLED at its default of off. */
export function realtimeText(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  const date = `${now.getFullYear()}年${pad(now.getMonth() + 1)}月${pad(now.getDate())}日`;
  return `## リアルタイム情報\n- 現在時刻: ${date}(${WEEKDAY_NAMES[now.getDay()]}) ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

/** Puts unsaved notices right before the last input. body: `last_input_index`; a tagged notice is a user turn here. */
export function insertBeforeLastInput(messages: ProviderMessage[], notices: ProviderMessage[]): ProviderMessage[] {
  const index = messages.findLastIndex((message) => message.role === "user");
  return index < 0 ? [...messages, ...notices] : [...messages.slice(0, index), ...notices, ...messages.slice(index)];
}
