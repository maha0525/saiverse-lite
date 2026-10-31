import {
  DEFAULT_SETTINGS,
  compareMessagePosition,
  createDefaultPersona,
  createDefaultProvider,
  normalizeSettings,
  type AppSettings,
  type ChatMessage,
  type ConversationThread,
  type FragmentRecord,
  type PageRecord,
  type Persona,
  type PersonaSession,
  type ProviderConfig,
  type RepositorySnapshot,
} from "../domain";
import {
  buildCoreMemoryPages,
  CATEGORY_CORE,
  createPersonaSession,
  createTrunkPages,
  epochSeconds,
  type CoreMemoryDraft,
} from "../pageRecords";
import { assertBatchOwner, type LiteRepository, type MessageRange, type PersonaRecordBatch } from "./repository";

function byUpdatedDesc<T extends { updatedAt: number }>(a: T, b: T): number {
  return b.updatedAt - a.updatedAt;
}

function byCreatedThenId(a: PageRecord, b: PageRecord): number {
  return a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function ownedKey(personaId: string, id: string): string {
  return `${personaId}\u0000${id}`;
}

function walk(messages: ChatMessage[], range: MessageRange): ChatMessage[] {
  if (range.limit <= 0) return [];
  const forward = range.direction === "forward";
  const ordered = [...messages].sort((a, b) => (forward ? 1 : -1) * compareMessagePosition(a, b));
  const { start, includeStart } = range;
  const walked = start
    ? ordered.filter((message) => {
      const order = (forward ? 1 : -1) * compareMessagePosition(message, start);
      return includeStart ? order >= 0 : order > 0;
    })
    : ordered;
  return structuredClone(walked.slice(0, range.limit));
}

export class MemoryRepository implements LiteRepository {
  private personas = new Map<string, Persona>();
  private threads = new Map<string, ConversationThread>();
  private messages = new Map<string, ChatMessage>();
  private pages = new Map<string, PageRecord>();
  private fragments = new Map<string, FragmentRecord>();
  private sessions = new Map<string, PersonaSession>();
  private providers = new Map<string, ProviderConfig>();
  private settings: AppSettings = { ...DEFAULT_SETTINGS };

  private ensurePersonaRecords(personaId: string): void {
    if (this.sessions.has(personaId)) return;
    for (const page of createTrunkPages(personaId, epochSeconds(Date.now()))) {
      this.pages.set(ownedKey(personaId, page.id), page);
    }
    this.sessions.set(personaId, createPersonaSession(personaId));
  }

  async initialize(): Promise<void> {
    if (this.providers.size === 0) this.providers.set("provider_mock", createDefaultProvider(1));
    if (this.personas.size === 0) this.personas.set("persona_first", createDefaultPersona(1));
    for (const id of this.personas.keys()) this.ensurePersonaRecords(id);
    this.settings = normalizeSettings(this.settings);
  }

  async listPersonas(): Promise<Persona[]> { return [...this.personas.values()].sort(byUpdatedDesc); }
  async getPersona(id: string): Promise<Persona | undefined> { return this.personas.get(id); }
  async putPersona(value: Persona): Promise<void> {
    this.personas.set(value.id, structuredClone(value));
    this.ensurePersonaRecords(value.id);
  }
  async deletePersona(id: string): Promise<void> {
    this.personas.delete(id);
    await this.deleteThreads([...this.threads.values()].filter((thread) => thread.personaId === id).map((thread) => thread.id));
    for (const message of [...this.messages.values()]) if (message.personaId === id) this.messages.delete(message.id);
    for (const page of [...this.pages.values()]) if (page.personaId === id) this.pages.delete(ownedKey(id, page.id));
    for (const fragment of [...this.fragments.values()]) if (fragment.personaId === id) this.fragments.delete(ownedKey(id, fragment.id));
    this.sessions.delete(id);
  }

  async listThreads(personaId: string): Promise<ConversationThread[]> {
    return [...this.threads.values()].filter((item) => item.personaId === personaId).sort(byUpdatedDesc);
  }
  async getThread(id: string): Promise<ConversationThread | undefined> { return this.threads.get(id); }
  async putThread(value: ConversationThread): Promise<void> { this.threads.set(value.id, structuredClone(value)); }
  async deleteThread(id: string): Promise<void> { await this.deleteThreads([id]); }
  async deleteThreads(ids: string[]): Promise<void> {
    const targetIds = new Set(ids.filter((id) => this.threads.has(id)));
    if (targetIds.size === 0) return;
    const personaIds = new Set([...targetIds].flatMap((id) => this.threads.get(id)?.personaId ?? []));
    for (const id of targetIds) this.threads.delete(id);
    const deletedMessageIds = new Set<string>();
    for (const message of [...this.messages.values()]) {
      if (!targetIds.has(message.threadId)) continue;
      this.messages.delete(message.id);
      deletedMessageIds.add(message.id);
    }
    for (const personaId of personaIds) {
      const session = this.sessions.get(personaId);
      if (!session) continue;
      const threadGone = session.activeThreadId !== null && targetIds.has(session.activeThreadId);
      const anchorGone = session.anchorMessageId !== null && deletedMessageIds.has(session.anchorMessageId);
      if (!threadGone && !anchorGone) continue;
      this.sessions.set(personaId, {
        ...session,
        activeThreadId: threadGone ? null : session.activeThreadId,
        anchorMessageId: threadGone || anchorGone ? null : session.anchorMessageId,
      });
    }
    console.info("[SAIVerse Lite][storage] Threads deleted", { deletedThreads: targetIds.size, deletedMessages: deletedMessageIds.size });
  }

  async listMessages(threadId: string): Promise<ChatMessage[]> {
    return [...this.messages.values()].filter((item) => item.threadId === threadId).sort(compareMessagePosition);
  }
  async getMessage(id: string): Promise<ChatMessage | undefined> {
    const message = this.messages.get(id);
    return message ? structuredClone(message) : undefined;
  }
  async readThreadMessages(threadId: string, range: MessageRange): Promise<ChatMessage[]> {
    return walk([...this.messages.values()].filter((item) => item.threadId === threadId), range);
  }
  async readPersonaMessages(personaId: string, range: MessageRange): Promise<ChatMessage[]> {
    return walk([...this.messages.values()].filter((item) => item.personaId === personaId), range);
  }
  async putMessage(value: ChatMessage): Promise<void> { this.messages.set(value.id, structuredClone(value)); }
  async deleteMessage(id: string): Promise<void> {
    const message = this.messages.get(id);
    const deleted = this.messages.delete(id);
    const session = message ? this.sessions.get(message.personaId) : undefined;
    if (session?.anchorMessageId === id) this.sessions.set(session.personaId, { ...session, anchorMessageId: null });
    console.info("[SAIVerse Lite][storage] Message deleted", { messageId: id, deleted });
  }
  async nextMessageSeq(personaId: string): Promise<number> {
    let highest = 0;
    for (const message of this.messages.values()) {
      if (message.personaId === personaId) highest = Math.max(highest, message.seq);
    }
    return highest + 1;
  }

  async listPages(personaId: string, category?: string): Promise<PageRecord[]> {
    return structuredClone([...this.pages.values()]
      .filter((page) => page.personaId === personaId && (category === undefined || page.category === category))
      .sort(byCreatedThenId));
  }
  async getPage(personaId: string, id: string): Promise<PageRecord | undefined> {
    const page = this.pages.get(ownedKey(personaId, id));
    return page ? structuredClone(page) : undefined;
  }
  async getPageByShortId(personaId: string, shortId: number): Promise<PageRecord | undefined> {
    const page = [...this.pages.values()].find((item) => item.personaId === personaId && item.shortId === shortId);
    return page ? structuredClone(page) : undefined;
  }
  async putPage(value: PageRecord): Promise<void> { this.pages.set(ownedKey(value.personaId, value.id), structuredClone(value)); }
  async deletePage(personaId: string, id: string): Promise<void> { this.pages.delete(ownedKey(personaId, id)); }
  async nextPageShortId(personaId: string): Promise<number> {
    let highest = 0;
    for (const page of this.pages.values()) {
      if (page.personaId === personaId) highest = Math.max(highest, page.shortId ?? 0);
    }
    return highest + 1;
  }
  async addCoreMemories(personaId: string, drafts: CoreMemoryDraft[]): Promise<PageRecord[]> {
    const written = buildCoreMemoryPages(
      personaId,
      await this.listPages(personaId, CATEGORY_CORE),
      await this.nextPageShortId(personaId),
      drafts,
      epochSeconds(Date.now()),
    );
    for (const page of written) await this.putPage(page);
    return written;
  }

  async listFragments(personaId: string, entityId?: string): Promise<FragmentRecord[]> {
    return structuredClone([...this.fragments.values()]
      .filter((item) => item.personaId === personaId && (entityId === undefined || item.entityId === entityId))
      .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));
  }
  async putFragment(value: FragmentRecord): Promise<void> { this.fragments.set(ownedKey(value.personaId, value.id), structuredClone(value)); }
  async deleteFragment(personaId: string, id: string): Promise<void> { this.fragments.delete(ownedKey(personaId, id)); }

  async getSession(personaId: string): Promise<PersonaSession | undefined> {
    const session = this.sessions.get(personaId);
    return session ? structuredClone(session) : undefined;
  }
  async putSession(value: PersonaSession): Promise<void> { this.sessions.set(value.personaId, structuredClone(value)); }
  async updateSession(personaId: string, update: (session: PersonaSession) => PersonaSession): Promise<PersonaSession> {
    const current = this.sessions.get(personaId);
    if (!current) throw new Error(`Session not found: ${personaId}`);
    const next = update(structuredClone(current));
    this.sessions.set(personaId, structuredClone(next));
    return structuredClone(next);
  }

  async writePersonaRecords(personaId: string, batch: PersonaRecordBatch): Promise<void> {
    assertBatchOwner(personaId, batch);
    for (const thread of batch.threads ?? []) await this.putThread(thread);
    for (const message of batch.messages ?? []) await this.putMessage(message);
    for (const page of batch.pages ?? []) await this.putPage(page);
    for (const fragment of batch.fragments ?? []) await this.putFragment(fragment);
  }

  async listProviders(): Promise<ProviderConfig[]> { return [...this.providers.values()].sort((a, b) => a.label.localeCompare(b.label)); }
  async getProvider(id: string): Promise<ProviderConfig | undefined> { return this.providers.get(id); }
  async putProvider(value: ProviderConfig): Promise<void> { this.providers.set(value.id, structuredClone(value)); }
  async deleteProvider(id: string): Promise<void> { if (id !== "provider_mock") this.providers.delete(id); }

  async getSettings(): Promise<AppSettings> { return normalizeSettings(structuredClone(this.settings)); }
  async putSettings(value: AppSettings): Promise<void> { this.settings = normalizeSettings(structuredClone(value)); }

  async exportSnapshot(includeSecrets = false): Promise<RepositorySnapshot> {
    const providers = (await this.listProviders()).map((provider) => ({
      ...provider,
      apiKey: includeSecrets ? provider.apiKey : "",
    }));
    return {
      personas: await this.listPersonas(),
      threads: [...this.threads.values()].sort(byUpdatedDesc),
      messages: [...this.messages.values()].sort(compareMessagePosition),
      pages: structuredClone([...this.pages.values()]),
      fragments: structuredClone([...this.fragments.values()]),
      sessions: structuredClone([...this.sessions.values()]),
      providers,
      settings: await this.getSettings(),
    };
  }

  async replaceSnapshot(snapshot: RepositorySnapshot): Promise<void> {
    this.personas = new Map(snapshot.personas.map((item) => [item.id, structuredClone(item)]));
    this.threads = new Map(snapshot.threads.map((item) => [item.id, structuredClone(item)]));
    this.messages = new Map(snapshot.messages.map((item) => [item.id, structuredClone(item)]));
    this.pages = new Map(snapshot.pages.map((item) => [ownedKey(item.personaId, item.id), structuredClone(item)]));
    this.fragments = new Map(snapshot.fragments.map((item) => [ownedKey(item.personaId, item.id), structuredClone(item)]));
    this.sessions = new Map(snapshot.sessions.map((item) => [item.personaId, structuredClone(item)]));
    this.providers = new Map(snapshot.providers.map((item) => [item.id, structuredClone(item)]));
    this.settings = normalizeSettings(snapshot.settings);
    for (const id of this.personas.keys()) this.ensurePersonaRecords(id);
  }
}
