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
    session = await repository.updateSession(persona.id, (current) => ({ ...current, ...head, anchorMessageId: anchorId }));
  }
  return { session, rows };
}
