import {
  DEFAULT_SETTINGS,
  createDefaultPersona,
  createDefaultProvider,
  type AppSettings,
  type ChatMessage,
  type ConversationThread,
  type MemoryEntry,
  type Persona,
  type ProviderConfig,
  type RepositorySnapshot,
} from "../domain";
import type { LiteRepository } from "./repository";

function byUpdatedDesc<T extends { updatedAt: number }>(a: T, b: T): number {
  return b.updatedAt - a.updatedAt;
}

export class MemoryRepository implements LiteRepository {
  private personas = new Map<string, Persona>();
  private threads = new Map<string, ConversationThread>();
  private messages = new Map<string, ChatMessage>();
  private memories = new Map<string, MemoryEntry>();
  private providers = new Map<string, ProviderConfig>();
  private settings: AppSettings = { ...DEFAULT_SETTINGS };

  async initialize(): Promise<void> {
    if (this.providers.size === 0) this.providers.set("provider_mock", createDefaultProvider(1));
    if (this.personas.size === 0) this.personas.set("persona_first", createDefaultPersona(1));
  }

  async listPersonas(): Promise<Persona[]> { return [...this.personas.values()].sort(byUpdatedDesc); }
  async getPersona(id: string): Promise<Persona | undefined> { return this.personas.get(id); }
  async putPersona(value: Persona): Promise<void> { this.personas.set(value.id, structuredClone(value)); }
  async deletePersona(id: string): Promise<void> {
    this.personas.delete(id);
    for (const thread of [...this.threads.values()]) if (thread.personaId === id) await this.deleteThread(thread.id);
    for (const memory of [...this.memories.values()]) if (memory.personaId === id) this.memories.delete(memory.id);
  }

  async listThreads(personaId: string): Promise<ConversationThread[]> {
    return [...this.threads.values()].filter((item) => item.personaId === personaId).sort(byUpdatedDesc);
  }
  async getThread(id: string): Promise<ConversationThread | undefined> { return this.threads.get(id); }
  async putThread(value: ConversationThread): Promise<void> { this.threads.set(value.id, structuredClone(value)); }
  async deleteThread(id: string): Promise<void> {
    this.threads.delete(id);
    for (const message of [...this.messages.values()]) if (message.threadId === id) this.messages.delete(message.id);
  }

  async listMessages(threadId: string): Promise<ChatMessage[]> {
    return [...this.messages.values()].filter((item) => item.threadId === threadId).sort((a, b) => a.createdAt - b.createdAt);
  }
  async putMessage(value: ChatMessage): Promise<void> { this.messages.set(value.id, structuredClone(value)); }
  async deleteMessage(id: string): Promise<void> { this.messages.delete(id); }

  async listMemories(personaId: string): Promise<MemoryEntry[]> {
    return [...this.memories.values()].filter((item) => item.personaId === personaId).sort(byUpdatedDesc);
  }
  async putMemory(value: MemoryEntry): Promise<void> { this.memories.set(value.id, structuredClone(value)); }
  async deleteMemory(id: string): Promise<void> { this.memories.delete(id); }

  async listProviders(): Promise<ProviderConfig[]> { return [...this.providers.values()].sort((a, b) => a.label.localeCompare(b.label)); }
  async getProvider(id: string): Promise<ProviderConfig | undefined> { return this.providers.get(id); }
  async putProvider(value: ProviderConfig): Promise<void> { this.providers.set(value.id, structuredClone(value)); }
  async deleteProvider(id: string): Promise<void> { if (id !== "provider_mock") this.providers.delete(id); }

  async getSettings(): Promise<AppSettings> { return structuredClone(this.settings); }
  async putSettings(value: AppSettings): Promise<void> { this.settings = structuredClone(value); }

  async exportSnapshot(includeSecrets = false): Promise<RepositorySnapshot> {
    const providers = (await this.listProviders()).map((provider) => ({
      ...provider,
      apiKey: includeSecrets ? provider.apiKey : "",
    }));
    return {
      personas: await this.listPersonas(),
      threads: [...this.threads.values()].sort(byUpdatedDesc),
      messages: [...this.messages.values()].sort((a, b) => a.createdAt - b.createdAt),
      memories: [...this.memories.values()].sort(byUpdatedDesc),
      providers,
      settings: await this.getSettings(),
    };
  }

  async replaceSnapshot(snapshot: RepositorySnapshot): Promise<void> {
    this.personas = new Map(snapshot.personas.map((item) => [item.id, structuredClone(item)]));
    this.threads = new Map(snapshot.threads.map((item) => [item.id, structuredClone(item)]));
    this.messages = new Map(snapshot.messages.map((item) => [item.id, structuredClone(item)]));
    this.memories = new Map(snapshot.memories.map((item) => [item.id, structuredClone(item)]));
    this.providers = new Map(snapshot.providers.map((item) => [item.id, structuredClone(item)]));
    this.settings = structuredClone(snapshot.settings);
  }
}
