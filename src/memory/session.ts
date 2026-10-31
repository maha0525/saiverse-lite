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

/**
 * Makes the session ready to compose a request for `threadId`. The head is left
 * alone unless the anchor moved or the user edited the system prompt, because the
 * head has to stay byte for byte the same between Metabolism runs.
 */
export async function prepareSession(repository: LiteRepository, persona: Persona, threadId: string): Promise<PreparedSession> {
  if (!(await repository.getSession(persona.id))) await repository.putSession(createPersonaSession(persona.id));
  let session = await repository.updateSession(persona.id, (current) => (
    current.activeThreadId === threadId ? current : { ...current, activeThreadId: threadId, anchorMessageId: null }
  ));

  let anchorId = session.anchorMessageId;
  if (anchorId === null) anchorId = await resolveInitialAnchor(repository, persona.id);
  let rows = anchorId ? await readWindow(repository, threadId, anchorId) : [];
  if (anchorId) {
    const floorId = await windowFloorAnchor(repository, threadId, anchorId, rows);
    if (floorId !== anchorId) {
      anchorId = floorId;
      rows = await readWindow(repository, threadId, anchorId);
    }
  }

  const anchorMoved = anchorId !== session.anchorMessageId;
  if (anchorMoved || session.headText === null || session.headSystemPrompt !== persona.systemPrompt) {
    const head = await buildHeadFields(repository, persona, threadId, anchorId);
    // The screen can change the thread while this reads; an anchor only holds for its own thread.
    session = await repository.updateSession(persona.id, (current) => (
      current.activeThreadId === threadId ? { ...current, ...head, anchorMessageId: anchorId } : current
    ));
  }
  return { session, rows };
}

/**
 * Makes `threadId` the thread the persona's conversation continues in, with its
 * anchor settled so the next response and Metabolism both see it. A persona
 * still importing keeps its session as it is: the import decides the thread.
 */
export async function activateThread(repository: LiteRepository, persona: Persona, threadId: string): Promise<PersonaSession> {
  const current = await repository.getSession(persona.id);
  if (current && (current.importState === "importing" || current.activeThreadId === threadId)) return current;
  return (await prepareSession(repository, persona, threadId)).session;
}
