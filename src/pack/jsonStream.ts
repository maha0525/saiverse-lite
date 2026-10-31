// Reads the top-level JSON array of a pack file one element at a time.
// Canon: saiverse_memory/persona_pack/json_stream.py in the body. An element is scanned to its
// end and handed to JSON.parse, so nothing depends on how the writer spaced or broke its lines.

import { PackError } from "./format";

const SPACE = 0x20, TAB = 0x09, LF = 0x0a, CR = 0x0d;
const QUOTE = 0x22, BACKSLASH = 0x5c, COMMA = 0x2c;
const OPEN_BRACKET = 0x5b, CLOSE_BRACKET = 0x5d, OPEN_BRACE = 0x7b, CLOSE_BRACE = 0x7d;

function isSpace(code: number): boolean {
  return code === SPACE || code === LF || code === CR || code === TAB;
}

async function* decodeChunks(source: AsyncIterable<Uint8Array>, name: string): AsyncGenerator<string> {
  // ignoreBOM keeps a BOM in the text, so the reader below can refuse it as json.loads does.
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  try {
    for await (const chunk of source) {
      const text = decoder.decode(chunk, { stream: true });
      if (text) yield text;
    }
    const rest = decoder.decode();
    if (rest) yield rest;
  } catch (error) {
    if (error instanceof TypeError) throw new PackError(`${name} が UTF-8 として読めません`);
    throw error;
  }
}

export interface JsonArrayOptions {
  maxElementChars: number;
}

export async function* iterJsonArray(
  source: AsyncIterable<Uint8Array>,
  name: string,
  { maxElementChars }: JsonArrayOptions,
): AsyncGenerator<unknown> {
  const chunks = decodeChunks(source, name);
  let text = "";
  let pos = 0;
  let index = 0;

  const invalid = () => new PackError(`${name} の JSON が壊れています (${index + 1} 番目の要素の付近)`);
  const tooLarge = () => new PackError(`${name} の ${index + 1} 番目の要素が上限の ${maxElementChars} 文字を超えています`);

  const nextChunk = async (): Promise<boolean> => {
    const next = await chunks.next();
    if (next.done) return false;
    text = next.value;
    pos = 0;
    return true;
  };
  /** Moves to the next non-space character. False at the end of the input. */
  const skipSpace = async (): Promise<boolean> => {
    for (;;) {
      while (pos < text.length && isSpace(text.charCodeAt(pos))) pos += 1;
      if (pos < text.length) return true;
      if (!(await nextChunk())) return false;
    }
  };
  const readElement = async (): Promise<string> => {
    const first = text.charCodeAt(pos);
    const isScalar = first !== OPEN_BRACE && first !== OPEN_BRACKET && first !== QUOTE;
    const parts: string[] = [];
    let length = 0;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let start = pos;
    const finish = () => {
      const tail = text.slice(start, pos);
      if (length + tail.length > maxElementChars) throw tooLarge();
      parts.push(tail);
      return parts.join("");
    };
    for (;;) {
      for (; pos < text.length; pos += 1) {
        const code = text.charCodeAt(pos);
        if (inString) {
          if (escaped) escaped = false;
          else if (code === BACKSLASH) escaped = true;
          else if (code === QUOTE) {
            inString = false;
            if (depth === 0) {
              pos += 1;
              return finish();
            }
          }
        } else if (isScalar) {
          if (isSpace(code) || code === COMMA || code === CLOSE_BRACKET || code === CLOSE_BRACE) return finish();
        } else if (code === QUOTE) {
          inString = true;
        } else if (code === OPEN_BRACE || code === OPEN_BRACKET) {
          depth += 1;
        } else if (code === CLOSE_BRACE || code === CLOSE_BRACKET) {
          depth -= 1;
          if (depth === 0) {
            pos += 1;
            return finish();
          }
        }
      }
      const tail = text.slice(start);
      length += tail.length;
      if (length > maxElementChars) throw tooLarge();
      parts.push(tail);
      if (!(await nextChunk())) {
        if (!isScalar) throw invalid();
        return parts.join("");
      }
      start = 0;
    }
  };

  if (!(await nextChunk())) throw invalid();
  if (text.charCodeAt(0) === 0xfeff) throw new PackError(`${name} の先頭に BOM が付いています`);
  if (!(await skipSpace())) throw invalid();
  if (text.charCodeAt(pos) !== OPEN_BRACKET) throw new PackError(`${name} が JSON の配列ではありません`);
  pos += 1;
  if (!(await skipSpace())) throw invalid();
  if (text.charCodeAt(pos) === CLOSE_BRACKET) {
    pos += 1;
  } else {
    for (;;) {
      const element = await readElement();
      let value: unknown;
      try {
        value = JSON.parse(element);
      } catch {
        throw invalid();
      }
      yield value;
      index += 1;
      if (!(await skipSpace())) throw invalid();
      const code = text.charCodeAt(pos);
      pos += 1;
      if (code === CLOSE_BRACKET) break;
      if (code !== COMMA) throw invalid();
      if (!(await skipSpace())) throw invalid();
    }
  }
  if (await skipSpace()) throw invalid();
}
