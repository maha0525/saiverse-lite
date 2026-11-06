import type { ToolCall } from "../domain";
import type { ProviderMessage } from "../llm/types";

// A port of the body's llm_clients/system_notice.py, for models that cannot take
// a system message mid-conversation. Lite sends every provider this way.

export const SYSTEM_NOTICE_PASSPHRASE_PLACEHOLDER = "{{SYSTEM_NOTICE_PASSPHRASE}}";

export const PASSPHRASE_LENGTH = 12;
const PASSPHRASE_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

export function generatePassphrase(): string {
  const limit = 256 - (256 % PASSPHRASE_ALPHABET.length);
  let passphrase = "";
  while (passphrase.length < PASSPHRASE_LENGTH) {
    for (const byte of crypto.getRandomValues(new Uint8Array(PASSPHRASE_LENGTH))) {
      if (byte < limit && passphrase.length < PASSPHRASE_LENGTH) passphrase += PASSPHRASE_ALPHABET[byte % PASSPHRASE_ALPHABET.length];
    }
  }
  return passphrase;
}

export function redactPassphrase(text: string, passphrase: string): string {
  return passphrase ? text.split(passphrase).join("*".repeat(passphrase.length)) : text;
}

function neutralizeSystemTags(text: string): string {
  return text.replace(/<(\/?)(system)/gi, "＜$1$2");
}

export function tagSystemNotice(body: string, passphrase: string): string {
  const text = redactPassphrase(neutralizeSystemTags(body), passphrase);
  return passphrase ? `<system pass="${passphrase}">\n${text}\n</system>` : `<system>\n${text}\n</system>`;
}

export function presentHead(headText: string, passphrase: string): string {
  return headText.split(SYSTEM_NOTICE_PASSPHRASE_PLACEHOLDER).join(passphrase);
}

export function noticeMessage(body: string, passphrase: string): ProviderMessage {
  return { role: "user", content: tagSystemNotice(body, passphrase), toolCallId: null, toolName: null, toolCalls: [] };
}

/** `encrypted_content` is opaque to Lite and breaks if rewritten. body: `_redact_reasoning_details` keeps signatures too. */
export function redactValue(value: unknown, passphrase: string): unknown {
  if (typeof value === "string") return redactPassphrase(value, passphrase);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, passphrase));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    key === "encrypted_content" ? item : redactValue(item, passphrase),
  ]));
}

function redactToolCall(call: ToolCall, passphrase: string): ToolCall {
  return { ...call, arguments: redactValue(call.arguments, passphrase) as Record<string, unknown> };
}

/** For the native tool turns of one response, which never pass through the row presentation. */
export function redactProviderMessage(message: ProviderMessage, passphrase: string): ProviderMessage {
  if (!passphrase) return message;
  return {
    ...message,
    content: redactPassphrase(message.content, passphrase),
    toolCalls: message.toolCalls.map((call) => redactToolCall(call, passphrase)),
    ...(message.providerState ? { providerState: redactValue(message.providerState, passphrase) as Record<string, unknown> } : {}),
  };
}
