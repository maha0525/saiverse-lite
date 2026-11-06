import type { ChatMessage, Persona, PersonaSession } from "../domain";
import { createPersonaSession } from "../pageRecords";
import type { LiteRepository } from "../storage/repository";
import { buildHeadFields } from "./head";
import { readWindow, resolveInitialAnchor, windowFloorAnchor } from "./window";

export interface PreparedSession {
  session: PersonaSession;
  /** The presented rows from the anchor on. */
  rows: ChatMessage[];
}

/** A pass is repeated only when another thread opens at the same moment, so a few are plenty. */
const MAX_PREPARE_PASSES = 5;

/**
 * The one place a lost anchor is found again. The row it names can be gone or in another
 * thread after a deleted message or thread, a rollback, or a deletion during Metabolism.
 */
async function usableAnchor(repository: LiteRepository, personaId: string, threadId: string, anchorId: string | null): Promise<string | null> {
  const anchor = anchorId === null ? undefined : await repository.getMessage(anchorId);
  return anchor?.threadId === threadId ? anchorId : resolveInitialAnchor(repository, personaId);
}

/** One pass of `prepareSession`. Null when the session moved on while this read: the rows are not its rows. */
async function preparePass(repository: LiteRepository, persona: Persona, threadId: string): Promise<PreparedSession | null> {
  const session = await repository.updateSession(persona.id, (current) => (
    current.activeThreadId === threadId ? current : { ...current, activeThreadId: threadId, anchorMessageId: null }
  ));

  const startId = await usableAnchor(repository, persona.id, threadId, session.anchorMessageId);
  let rows = startId ? await readWindow(repository, threadId, startId) : [];
  const anchorId = startId ? await windowFloorAnchor(repository, threadId, startId, rows) : null;
  if (anchorId !== startId && anchorId) rows = await readWindow(repository, threadId, anchorId);

  const rebuild = anchorId !== session.anchorMessageId || session.headText === null || session.headSystemPrompt !== persona.systemPrompt;
  const head = rebuild ? await buildHeadFields(repository, persona, threadId, anchorId) : null;
  const settled = await repository.updateSession(persona.id, (current) => (
    head && current.activeThreadId === threadId && current.anchorMessageId === session.anchorMessageId
      ? { ...current, ...head, anchorMessageId: anchorId }
      : current
  ));
  return settled.activeThreadId === threadId && settled.anchorMessageId === anchorId ? { session: settled, rows } : null;
}

/**
 * Makes the session ready to compose a request for `threadId`. The head is left
 * alone unless the anchor moved or the user edited the system prompt, because the
 * head has to stay byte for byte the same between Metabolism runs. The session and
 * the rows it returns are always of `threadId`: the thread or the anchor changing
 * underneath starts the pass over.
 */
export async function prepareSession(repository: LiteRepository, persona: Persona, threadId: string): Promise<PreparedSession> {
  if (!(await repository.getSession(persona.id))) await repository.putSession(createPersonaSession(persona.id));
  for (let pass = 0; pass < MAX_PREPARE_PASSES; pass += 1) {
    const prepared = await preparePass(repository, persona, threadId);
    if (prepared) return prepared;
  }
  throw new Error("会話の切り替えが重なったため、準備を終えられませんでした。もう一度お試しください。");
}

/**
 * Makes `threadId` the thread the persona's conversation continues in, with its
 * anchor settled so the next response and Metabolism both see it. A persona
 * still importing keeps its session as it is: the import decides the thread.
 * The screen has moved on when another thread took over during the pass, so this
 * does not take it back.
 */
export async function activateThread(repository: LiteRepository, persona: Persona, threadId: string): Promise<PersonaSession> {
  const current = await repository.getSession(persona.id);
  if (current && (current.importState === "importing" || current.activeThreadId === threadId)) return current;
  if (!current) await repository.putSession(createPersonaSession(persona.id));
  const prepared = await preparePass(repository, persona, threadId);
  return prepared?.session ?? (await repository.getSession(persona.id))!;
}
