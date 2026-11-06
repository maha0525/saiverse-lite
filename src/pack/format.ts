// Value encoding of a persona pack. Canon: saiverse_memory/persona_pack/format.py in the body.

export const FORMAT_NAME = "persona-pack";
export const FORMAT_VERSION = "1.0";
export const MANIFEST_NAME = "manifest.json";

export const BYTES_MARKER = "__bytes_b64__";
export const RAW_TEXT_MARKER = "__raw_text__";
export const ESCAPED_MARKER = "__escaped__";

/** body: importer.py MAX_JSON_ELEMENT_CHARS. Counted here in UTF-16 units. */
export const MAX_JSON_ELEMENT_CHARS = 64 * 1024 * 1024;
/** body: importer.py MAX_UNCOMPRESSED_BYTES. */
export const MAX_UNCOMPRESSED_BYTES = 8 * 2 * 1024 * 1024 * 1024;

/** A refusal whose message tells the person what to do, and is shown as it is. */
export class PackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PackError";
  }
}

/** The file is not a pack that can be read. The message names the place, for the log. */
export class PackFormatError extends PackError {
  constructor(message: string) {
    super(message);
    this.name = "PackFormatError";
  }
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const NON_FINITE_MARK = "__persona_pack_non_finite__";
const NON_FINITE_VALUES = new Map([["NaN", Number.NaN], ["Infinity", Number.POSITIVE_INFINITY], ["-Infinity", Number.NEGATIVE_INFINITY]]);

/** body: json.loads reads NaN, Infinity and -Infinity, and json.dumps writes them. JSON.parse reads neither. */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    if (!/NaN|Infinity/.test(text)) throw error;
    const marked = text.replace(/"(?:[^"\\]+|\\.)*"|-?Infinity|NaN/g, (token) => (token.startsWith('"') ? token : `"${NON_FINITE_MARK}${token}"`));
    return JSON.parse(marked, (_key, value: unknown) => {
      if (typeof value !== "string" || !value.startsWith(NON_FINITE_MARK)) return value;
      return NON_FINITE_VALUES.get(value.slice(NON_FINITE_MARK.length)) ?? value;
    });
  }
}

/** body: json.dumps writes NaN and the infinities as bare words, and JSON.stringify would write null. */
export function stringifyJson(value: unknown, indent?: number): string {
  let marked = false;
  const text = JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item !== "number" || Number.isFinite(item)) return item;
    marked = true;
    return `${NON_FINITE_MARK}${item}`;
  }, indent);
  return marked ? text.replace(new RegExp(`"${NON_FINITE_MARK}(NaN|-?Infinity)"`, "g"), "$1") : text;
}

export function bytesToBase64(bytes: Uint8Array): string {
  const pieces: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    pieces.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
  }
  return btoa(pieces.join(""));
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value.replace(/[^A-Za-z0-9+/=]/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** body: format.py decode_value. Bytes come back as Uint8Array. Throws on bad base64. */
export function decodeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeValue);
  if (!isObject(value)) return value;
  const keys = Object.keys(value);
  if (keys.length === 1) {
    const escaped = value[ESCAPED_MARKER];
    if (isObject(escaped)) return Object.fromEntries(Object.entries(escaped).map(([key, item]) => [key, decodeValue(item)]));
    const bytes = value[BYTES_MARKER];
    if (typeof bytes === "string") return base64ToBytes(bytes);
    const raw = value[RAW_TEXT_MARKER];
    if (typeof raw === "string") return raw;
  }
  return Object.fromEntries(keys.map((key) => [key, decodeValue(value[key])]));
}

/** body: format.py encode_value, the inverse of `decodeValue`. */
export function encodeValue(value: unknown): unknown {
  if (value instanceof Uint8Array) return { [BYTES_MARKER]: bytesToBase64(value) };
  if (Array.isArray(value)) return value.map(encodeValue);
  if (!isObject(value)) return value;
  const encoded = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encodeValue(item)]));
  const keys = Object.keys(encoded);
  const markerShaped = keys.length === 1 && [BYTES_MARKER, RAW_TEXT_MARKER, ESCAPED_MARKER].includes(keys[0]!);
  return markerShaped ? { [ESCAPED_MARKER]: encoded } : encoded;
}

/** The value of a text column as a persona reads it. NULL is empty. */
export function decodeText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  const decoded = decodeValue(value);
  if (typeof decoded === "string") return decoded;
  if (decoded instanceof Uint8Array) return new TextDecoder().decode(decoded);
  return JSON.stringify(decoded);
}

// body: json.detect_encoding, which `json.loads(bytes)` uses.
function detectJsonEncoding(data: Uint8Array): string {
  const [a, b, c, d] = [data[0], data[1], data[2], data[3]];
  if (a === 0xef && b === 0xbb && c === 0xbf) return "utf-8";
  if (a === 0xff && b === 0xfe) return c === 0 && d === 0 ? "utf-32le" : "utf-16le";
  if (a === 0xfe && b === 0xff) return "utf-16be";
  if (a === 0 && b === 0 && c === 0xfe && d === 0xff) return "utf-32be";
  if (data.length >= 4) {
    if (a === 0) return b === 0 ? "utf-32be" : "utf-16be";
    if (b === 0) return c === 0 && d === 0 ? "utf-32le" : "utf-16le";
  } else if (data.length === 2) {
    if (a === 0) return "utf-16be";
    if (b === 0) return "utf-16le";
  }
  return "utf-8";
}

function decodeUtf32(data: Uint8Array, littleEndian: boolean): string {
  if (data.length % 4 !== 0) throw new TypeError("truncated UTF-32");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let text = "";
  for (let offset = 0; offset < data.length; offset += 4) text += String.fromCodePoint(view.getUint32(offset, littleEndian));
  return text;
}

function isBytesWrapper(value: unknown): value is Record<string, string> {
  return isObject(value) && Object.keys(value).length === 1 && typeof value[BYTES_MARKER] === "string";
}

/** body: importer.py _raw_text_is_structured. */
function rawTextIsStructured(value: unknown): boolean {
  if (!isObject(value) || Object.keys(value).length !== 1 || typeof value[RAW_TEXT_MARKER] !== "string") return false;
  try {
    const parsed = parseJson(value[RAW_TEXT_MARKER]);
    return typeof parsed === "object" && parsed !== null;
  } catch (error) {
    return error instanceof RangeError;
  }
}

/** body: importer.py _json_bytes_to_text, with the encoding `json.loads(bytes)` detects. Throws when it does not decode. */
function jsonBytesToText(data: Uint8Array): string {
  const encoding = detectJsonEncoding(data);
  if (encoding === "utf-32le" || encoding === "utf-32be") return decodeUtf32(data, encoding === "utf-32le");
  return new TextDecoder(encoding, { fatal: true }).decode(data);
}

function bytesAreText(value: Record<string, string>): boolean {
  try {
    jsonBytesToText(base64ToBytes(value[BYTES_MARKER] ?? ""));
    return true;
  } catch {
    return false;
  }
}

/**
 * The value of a JSON text column as Lite works with it: the wrappers taken off, and text
 * parsed the way the body's readers `json.loads` the column. Null when it reads as nothing.
 */
export function decodeJsonColumn(value: unknown): unknown {
  try {
    const decoded = decodeValue(value);
    if (decoded instanceof Uint8Array) return parseJson(jsonBytesToText(decoded));
    return typeof decoded === "string" ? parseJson(decoded) : decoded;
  } catch {
    return null;
  }
}

/**
 * body: importer.py _refuse_structured_raw_text. The columns of `columns` that keep the row
 * out of the import. A bytes wrapper that reads as text stays in `source` as it came;
 * `decodeJsonColumn` reads it for the working value.
 */
export function refusedJsonTextColumns(row: Record<string, unknown>, columns: readonly string[]): string[] {
  return columns.filter((column) => {
    const value = row[column];
    return isBytesWrapper(value) ? !bytesAreText(value) : rawTextIsStructured(value);
  });
}

const ISO_PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?(Z|[+-]\d{2}(?::?\d{2})?)?)?$/;

function isoToMilliseconds(value: string): number | null {
  const match = ISO_PATTERN.exec(value.trim());
  if (!match) return null;
  const [, year, month, day, hour, minute, second, fraction, zone] = match;
  const base = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour ?? 0), Number(minute ?? 0), Number(second ?? 0));
  if (Number.isNaN(base)) return null;
  let offsetMinutes = 0;
  if (zone && zone !== "Z") {
    const digits = zone.slice(1).replace(":", "");
    offsetMinutes = (zone.startsWith("-") ? -1 : 1) * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4) || 0));
  }
  return base + (fraction ? Number(`0.${fraction}`) * 1000 : 0) - offsetMinutes * 60_000;
}

/** A pack time: epoch seconds or the ISO text of format.py epoch_to_iso. Null if it is neither. */
export function packTimeToMilliseconds(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value * 1000;
  return typeof value === "string" ? isoToMilliseconds(value) : null;
}

/** body: format.py epoch_to_iso. */
export function epochToIso(seconds: number): string {
  const whole = Math.floor(seconds);
  const microseconds = Math.round((seconds - whole) * 1_000_000);
  const fraction = microseconds ? `.${String(microseconds).padStart(6, "0")}` : "";
  return `${new Date(whole * 1000).toISOString().slice(0, 19)}${fraction}+00:00`;
}

/** body: format.py iso_to_epoch. Epoch seconds, whole unless the source has a fraction. */
export function packTimeToSeconds(value: unknown): number | null {
  const milliseconds = packTimeToMilliseconds(value);
  return milliseconds === null ? null : milliseconds / 1000;
}
