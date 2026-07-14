import { useCallback, useEffect, useState } from "react";
import { ChatService } from "./chatService";
import { ChatView } from "./components/ChatView";
import { DataView } from "./components/DataView";
import { MemoryView } from "./components/MemoryView";
import { Nav, type AppView } from "./components/Nav";
import { PersonaView } from "./components/PersonaView";
import { SettingsView } from "./components/SettingsView";
import {
  DEFAULT_SETTINGS,
  newId,
  type AppSettings,
  type ChatMessage,
  type ConversationThread,
  type MemoryEntry,
  type Persona,
  type ProviderConfig,
} from "./domain";
import { exportFullBackup, exportPersona, exportSaiverseMemory, importSaiverseMemory, parseFullBackup, stringifyExport } from "./formats";
import { ChatGptExportAdapter, ClaudeExportAdapter, saveImportedConversations } from "./importers";
import { IndexedDbRepository } from "./storage/indexedDbRepository";
import { requestPersistentStorage } from "./storage/repository";

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const repository = new IndexedDbRepository();
const chatService = new ChatService(repository);

function downloadJson(filename: string, value: unknown): void {
  const blob = new Blob([stringifyExport(value)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function App() {
  const [view, setView] = useState<AppView>("chat");
  const [loading, setLoading] = useState(true);
  const [online, setOnline] = useState(navigator.onLine);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [selectedPersonaId, setSelectedPersonaId] = useState("");
  const [threads, setThreads] = useState<ConversationThread[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [memories, setMemories] = useState<MemoryEntry[]>([]);
  const [streamingText, setStreamingText] = useState("");
  const [chatStatus, setChatStatus] = useState("");
  const [sending, setSending] = useState(false);
  const [dataBusy, setDataBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);

  const selectedPersona = personas.find((persona) => persona.id === selectedPersonaId) ?? personas[0];
  const activeThread = threads.find((thread) => thread.id === activeThreadId) ?? null;

  const loadThread = useCallback(async (threadId: string | null) => {
    setActiveThreadId(threadId);
    setMessages(threadId ? await repository.listMessages(threadId) : []);
  }, []);

  const loadPersonaData = useCallback(async (personaId: string, preferredThreadId?: string) => {
    let nextThreads = await repository.listThreads(personaId);
    if (nextThreads.length === 0) {
      const now = Date.now();
      const thread: ConversationThread = { id: newId("thread"), personaId, title: "新しい会話", createdAt: now, updatedAt: now };
      await repository.putThread(thread);
      nextThreads = [thread];
    }
    setThreads(nextThreads);
    setMemories(await repository.listMemories(personaId));
    const nextThreadId = preferredThreadId && nextThreads.some((thread) => thread.id === preferredThreadId)
      ? preferredThreadId
      : nextThreads[0]?.id ?? null;
    await loadThread(nextThreadId);
  }, [loadThread]);

  const refreshBase = useCallback(async (preferredPersonaId?: string) => {
    const [nextPersonas, nextProviders, nextSettings] = await Promise.all([
      repository.listPersonas(), repository.listProviders(), repository.getSettings(),
    ]);
    setPersonas(nextPersonas);
    setProviders(nextProviders);
    setSettings(nextSettings);
    const nextPersonaId = preferredPersonaId && nextPersonas.some((persona) => persona.id === preferredPersonaId)
      ? preferredPersonaId
      : nextPersonas[0]?.id ?? "";
    setSelectedPersonaId(nextPersonaId);
    if (nextPersonaId) await loadPersonaData(nextPersonaId);
  }, [loadPersonaData]);

  useEffect(() => {
    void (async () => {
      try {
        await repository.initialize();
        const persisted = await requestPersistentStorage();
        const current = await repository.getSettings();
        if (current.storagePersisted !== persisted) await repository.putSettings({ ...current, storagePersisted: persisted });
        await refreshBase();
      } catch (error) {
        console.error("[SAIVerse Lite] initialization failed", error);
        setNotice(`初期化に失敗しました: ${errorMessage(error)}`);
      } finally {
        setLoading(false);
      }
    })();
  }, [refreshBase]);

  useEffect(() => {
    const onlineHandler = () => setOnline(true);
    const offlineHandler = () => setOnline(false);
    const installHandler = (event: Event) => { event.preventDefault(); setInstallPrompt(event as BeforeInstallPromptEvent); };
    window.addEventListener("online", onlineHandler);
    window.addEventListener("offline", offlineHandler);
    window.addEventListener("beforeinstallprompt", installHandler);
    return () => {
      window.removeEventListener("online", onlineHandler);
      window.removeEventListener("offline", offlineHandler);
      window.removeEventListener("beforeinstallprompt", installHandler);
    };
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const resolved = settings.theme === "system" ? (media.matches ? "dark" : "light") : settings.theme;
      document.documentElement.dataset.theme = resolved;
      document.querySelector('meta[name="theme-color"]')?.setAttribute("content", resolved === "dark" ? "#101317" : "#f4f1ea");
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [settings.theme]);

  const selectPersona = async (id: string) => {
    setSelectedPersonaId(id);
    await loadPersonaData(id);
  };

  const refreshConversation = async () => {
    if (!selectedPersona) return;
    const preferred = activeThreadId ?? undefined;
    await loadPersonaData(selectedPersona.id, preferred);
  };

  const createThread = async () => {
    if (!selectedPersona) return;
    const now = Date.now();
    const thread: ConversationThread = { id: newId("thread"), personaId: selectedPersona.id, title: "新しい会話", createdAt: now, updatedAt: now };
    await repository.putThread(thread);
    await loadPersonaData(selectedPersona.id, thread.id);
  };

  const deleteThread = async (id: string) => {
    if (!selectedPersona || !window.confirm("このスレッドの会話を削除しますか？")) return;
    await repository.deleteThread(id);
    await loadPersonaData(selectedPersona.id);
  };

  const send = async (text: string) => {
    if (!selectedPersona || !activeThread) return;
    setSending(true);
    setStreamingText("");
    setNotice("");
    try {
      await chatService.send(selectedPersona, activeThread, text, {
        onDelta: (delta) => setStreamingText((current) => current + delta),
        onStatus: setChatStatus,
      });
      await refreshConversation();
    } catch (error) {
      console.error("[SAIVerse Lite][chat] send failed", error);
      setNotice(`送信できませんでした: ${errorMessage(error)}`);
      await refreshConversation();
    } finally {
      setSending(false);
      setStreamingText("");
      setChatStatus("");
    }
  };

  const editMessage = async (message: ChatMessage, content: string) => {
    const currentMessages = await repository.listMessages(message.threadId);
    if (message.role === "user") {
      const position = currentMessages.findIndex((item) => item.id === message.id);
      for (const later of currentMessages.slice(position + 1)) await repository.deleteMessage(later.id);
    }
    await repository.putMessage({ ...message, content, editedAt: Date.now() });
    await loadThread(message.threadId);
  };

  const regenerate = async () => {
    if (!selectedPersona || !activeThreadId || sending) return;
    setSending(true);
    setStreamingText("");
    try {
      await chatService.regenerate(selectedPersona, activeThreadId, {
        onDelta: (delta) => setStreamingText((current) => current + delta),
        onStatus: setChatStatus,
      });
      await refreshConversation();
    } catch (error) {
      setNotice(`再生成できませんでした: ${errorMessage(error)}`);
    } finally {
      setSending(false); setStreamingText(""); setChatStatus("");
    }
  };

  const savePersona = async (persona: Persona) => { await repository.putPersona(persona); await refreshBase(persona.id); };
  const deletePersona = async (id: string) => {
    if (!window.confirm("このパートナーと端末内の会話・記憶を削除しますか？")) return;
    await repository.deletePersona(id);
    await refreshBase();
  };
  const createMemory = async (content: string) => {
    if (!selectedPersona) return;
    const now = Date.now();
    await repository.putMemory({ id: newId("memory"), personaId: selectedPersona.id, threadId: null, kind: "note", content, sourceMessageIds: [], createdAt: now, updatedAt: now });
    setMemories(await repository.listMemories(selectedPersona.id));
  };
  const editMemory = async (memory: MemoryEntry, content: string) => {
    await repository.putMemory({ ...memory, content, updatedAt: Date.now() });
    if (selectedPersona) setMemories(await repository.listMemories(selectedPersona.id));
  };
  const deleteMemory = async (id: string) => {
    if (!window.confirm("この記憶を削除しますか？")) return;
    await repository.deleteMemory(id);
    if (selectedPersona) setMemories(await repository.listMemories(selectedPersona.id));
  };

  const exportCurrentMemory = async () => {
    if (!selectedPersona) return;
    const snapshot = await repository.exportSnapshot();
    const value = exportSaiverseMemory(selectedPersona, snapshot.threads, snapshot.messages, snapshot.memories);
    downloadJson(`${selectedPersona.id}_saiverse-memory.json`, value);
  };

  const runDataAction = async (action: () => Promise<string>) => {
    setDataBusy(true); setNotice("");
    try { setNotice(await action()); } catch (error) { console.error("[SAIVerse Lite][data] action failed", error); setNotice(`処理できませんでした: ${errorMessage(error)}`); }
    finally { setDataBusy(false); }
  };

  const content = (() => {
    if (!selectedPersona) return <div className="empty-state"><h2>パートナーを読み込めませんでした</h2></div>;
    if (view === "chat") return <ChatView persona={selectedPersona} threads={threads} activeThreadId={activeThreadId} messages={messages} streamingText={streamingText} status={chatStatus} sending={sending} onSelectThread={(id) => void loadThread(id)} onCreateThread={() => void createThread()} onDeleteThread={(id) => void deleteThread(id)} onSend={send} onEdit={editMessage} onRegenerate={regenerate} />;
    if (view === "personas") return <PersonaView personas={personas} providers={providers} selectedId={selectedPersona.id} onSelect={(id) => void selectPersona(id)} onSave={savePersona} onDelete={deletePersona} />;
    if (view === "memory") return <MemoryView persona={selectedPersona} memories={memories} onCreate={createMemory} onEdit={editMemory} onDelete={deleteMemory} />;
    if (view === "data") return <DataView
      persona={selectedPersona} busy={dataBusy} notice={notice}
      onExportPersona={() => downloadJson(`${selectedPersona.id}_persona.json`, exportPersona(selectedPersona))}
      onExportMemory={exportCurrentMemory}
      onExportBackup={() => runDataAction(async () => { downloadJson("saiverse-lite-backup.json", exportFullBackup(await repository.exportSnapshot())); return "フルバックアップを書き出しました。"; })}
      onImportBackup={(file) => runDataAction(async () => { if (!window.confirm("現在の端末内データをバックアップ内容で置き換えますか？")) return "復元をキャンセルしました。"; await repository.replaceSnapshot(parseFullBackup(JSON.parse(await file.text()))); await refreshBase(); return "バックアップを復元しました。APIキーは再入力してください。"; })}
      onImportNative={(file) => runDataAction(async () => { const imported = importSaiverseMemory(JSON.parse(await file.text()), selectedPersona.id); for (const thread of imported.threads) await repository.putThread(thread); for (const message of imported.messages) await repository.putMessage(message); for (const memory of imported.memories) await repository.putMemory(memory); await loadPersonaData(selectedPersona.id); return `${imported.threads.length}スレッド、${imported.messages.length}発言、${imported.memories.length}記憶を取り込みました。`; })}
      onImportChatGpt={(file) => runDataAction(async () => { const conversations = await new ChatGptExportAdapter().parse(file); const result = await saveImportedConversations(repository, selectedPersona, conversations); await loadPersonaData(selectedPersona.id); return `${result.threads}会話、${result.messages}発言を取り込みました。`; })}
      onImportClaude={(file) => runDataAction(async () => { await new ClaudeExportAdapter().parse(file); return ""; })}
    />;
    return <SettingsView providers={providers} settings={settings} canInstall={installPrompt !== null} onInstall={async () => { if (!installPrompt) return; await installPrompt.prompt(); const choice = await installPrompt.userChoice; if (choice.outcome === "accepted") setInstallPrompt(null); }} onSaveProvider={async (provider) => { await repository.putProvider(provider); setProviders(await repository.listProviders()); }} onDeleteProvider={async (id) => {
      const users = personas.filter((persona) => persona.providerId === id);
      if (users.length) { setNotice(`${users.map((persona) => persona.name).join("、")}が使用中のため削除できません。`); return; }
      await repository.deleteProvider(id); setProviders(await repository.listProviders());
    }} onSaveSettings={async (value) => { await repository.putSettings(value); setSettings(value); }} />;
  })();

  if (loading) return <main className="loading-screen"><div className="brand-mark">九</div><h1>SAIVerse Lite</h1><p>部屋を整えています…</p></main>;
  return (
    <div className="app-shell">
      <Nav active={view} onChange={setView} online={online} />
      <main className="main-stage">
        {notice && view !== "data" && <div className="global-notice" role="alert"><span>{notice}</span><button onClick={() => setNotice("")} aria-label="閉じる">×</button></div>}
        {content}
      </main>
    </div>
  );
}
