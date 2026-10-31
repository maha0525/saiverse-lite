import type { ChatMessage } from "../domain";
import { conversationChars, conversationLength, materialChars, totalChars } from "./window";

// A port of the body's sea/eviction_plan.py `plan_eviction`, without the parts
// Lite does not carry: injected perception blocks and folded ranges.

/** The presented chars a closed fold is expected to leave behind. body: ESTIMATED_FOLD_PLACEHOLDER_CHARS. */
const ESTIMATED_FOLD_PLACEHOLDER_CHARS = 1_200;

export interface EvictionOptions {
  /** The kept amount. Counted in conversation rows only. */
  targetChars: number;
  /** The chars of material one level 1 entry covers. */
  unitChars: number;
  /** Closes an undersized tail when no fold closed. Only the run before a response uses it. */
  closeUndersizedTail?: boolean;
}

export interface EvictionPlan {
  /** Contiguous from the first row, oldest first. */
  folds: ChatMessage[][];
  protectedFrom: number;
  totalChars: number;
  conversationChars: number;
}

type Unit = [start: number, end: number];

function spellOriginId(message: ChatMessage): string | null {
  const origin = message.source?.spell_origin_id;
  return typeof origin === "string" && origin ? origin : null;
}

/** body: sai_memory/memory/storage.py `spell_group_spans`. */
function spellGroupSpans(messages: ChatMessage[]): Unit[] {
  const origins = new Set(messages.flatMap((message) => spellOriginId(message) ?? []));
  const spans = new Map<string, Unit>();
  messages.forEach((message, index) => {
    const key = spellOriginId(message) ?? (origins.has(message.id) ? message.id : null);
    if (key === null) return;
    const span = spans.get(key);
    if (span) span[1] = index;
    else spans.set(key, [index, index]);
  });
  return [...spans.values()].filter(([low, high]) => high > low).sort((a, b) => a[0] - b[0]);
}

function unitIndexOf(units: Unit[], position: number): number {
  return units.findIndex(([start, end]) => start <= position && position <= end);
}

/** Runs of one pulse_id, with every spell group merged into the units it touches. */
function jointUnits(messages: ChatMessage[]): Unit[] {
  const units: Unit[] = [];
  let currentPulse: string | null = null;
  messages.forEach((message, index) => {
    const last = units.at(-1);
    if (last && message.pulseId !== null && message.pulseId === currentPulse) {
      last[1] = index;
      return;
    }
    units.push([index, index]);
    currentPulse = message.pulseId;
  });
  for (const [low, high] of spellGroupSpans(messages)) {
    const first = unitIndexOf(units, low);
    const last = unitIndexOf(units, high);
    if (first < 0 || last < 0 || first === last) continue;
    units.splice(first, last - first + 1, [units[first]![0], units[last]![1]]);
  }
  return units;
}

function protectionBoundary(messages: ChatMessage[], keepChars: number, units: Unit[]): number {
  if (keepChars <= 0) return messages.length;
  let accumulated = 0;
  let rawBoundary = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    accumulated += conversationLength(messages[index]!);
    if (accumulated >= keepChars) {
      rawBoundary = index;
      break;
    }
  }
  if (rawBoundary < 0) return 0;
  const unit = units[unitIndexOf(units, rawBoundary)];
  if (!unit) return rawBoundary;
  const [unitStart, unitEnd] = unit;
  if (unitStart > 0 || rawBoundary <= 0) return unitStart;
  // Snapping older removed the boundary: the unit starts the window. Moving it
  // newer keeps the unit whole and still makes progress, unless that unit is the
  // whole window, where only the raw boundary leaves anything to anchor on.
  return unitEnd + 1 < messages.length ? unitEnd + 1 : rawBoundary;
}

function netReduction(messages: ChatMessage[]): number {
  return Math.max(0, totalChars(messages) - ESTIMATED_FOLD_PLACEHOLDER_CHARS);
}

export function planEviction(messages: ChatMessage[], options: EvictionOptions): EvictionPlan {
  const plan: EvictionPlan = {
    folds: [],
    protectedFrom: 0,
    totalChars: totalChars(messages),
    conversationChars: conversationChars(messages),
  };
  if (messages.length === 0) return plan;
  const units = jointUnits(messages);
  const boundary = protectionBoundary(messages, options.targetChars, units);
  plan.protectedFrom = boundary;
  if (boundary <= 0) return plan;

  let pending: ChatMessage[] = [];
  for (const [start, end] of units) {
    if (start >= boundary) break;
    pending.push(...messages.slice(start, Math.min(end + 1, boundary)));
    if (materialChars(pending) >= options.unitChars) {
      plan.folds.push(pending);
      pending = [];
    }
  }
  if (pending.length > 0 && options.closeUndersizedTail && plan.folds.length === 0 && netReduction(pending) > 0) {
    plan.folds.push(pending);
  }
  return plan;
}

/** The rows one level 1 entry should cover within a run. body: sai_memory/arasuji/alignment.py `_plan_run`. */
export function planRunChunks(run: ChatMessage[], unitChars: number): ChatMessage[][] {
  const blocked = new Set<number>();
  for (const [low, high] of spellGroupSpans(run)) {
    for (let index = low; index < high; index += 1) blocked.add(index);
  }
  const chunks: ChatMessage[][] = [];
  let pending: ChatMessage[] = [];
  run.forEach((message, index) => {
    pending.push(message);
    if (materialChars(pending) >= unitChars && !blocked.has(index)) {
      chunks.push(pending);
      pending = [];
    }
  });
  if (pending.length > 0) {
    const previous = chunks.pop();
    chunks.push(previous ? [...previous, ...pending] : pending);
  }
  return chunks;
}
