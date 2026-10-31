import { useCallback, useEffect, useRef, useState } from "react";
import logoUrl from "./assets/logo.png";
import { ChatService, type ChatStatusTone, type MetabolismState } from "./chatService";
import { ChatOperationError, presentChatError, type ChatErrorPresentation } from "./chatErrors";
import { ChatErrorNotice } from "./components/ChatErrorNotice";
import { ChatView } from "./components/ChatView";
import { DataView } from "./components/DataView";
import { ImportResumePanel } from "./components/ImportResumePanel";
import { MemoryView } from "./components/MemoryView";
import { Nav, type AppView } from "./components/Nav";
import { PackImportDialog } from "./components/PackImportDialog";
import { PersonaView } from "./components/PersonaView";
import { SettingsView } from "./components/SettingsView";
import { deleteRowsAfter, hasRowsAfter, MESSAGE_PAGE_ROWS, readLatestRows, readOlderRows } from "./conversationPage";
import {
  DEFAULT_SETTINGS,
  newId,
  type AppSettings,
  type ChatMessage,
  type ConversationThread,
  type Persona,
  type PersonaSession,
  type ProviderConfig,
} from "./domain";
import { exportFullBackup, exportPersona, exportSaiverseMemory, importSaiverseMemory, parseFullBackup, stringifyExport } from "./formats";
import { saveClaudeMemories, saveImportedConversations, saveSaiverseMemoryImport, type ClaudeMemoryText, type ImportedConversation } from "./importers";
import { ensureEngine, getEngineStatus, subscribe as subscribeLiteRtEngine, type LiteRtEngineStatus } from "./llm/litertEngine";
import { isLiteRtModelId } from "./llm/litertModels";
import type { ConversationImportTarget } from "./components/OfficialImportDialog";
import { LEGAL_VERSION } from "./legal";
import { completeOnboarding, loadOnboarding, resetOnboarding, saveDraft } from "./onboarding";
import { OnboardingWizard } from "./components/OnboardingWizard";
import { withoutPassphrase } from "./memory/conversation";
import { activateThread } from "./memory/session";
import { resolveInitialAnchor } from "./memory/window";
import { readAttachment, type AttachmentItem } from "./pack/attachments";
import { importPersonaPack, type PackImportProgress } from "./pack/importPack";
import { OpfsPackStore } from "./pack/packStore";
import { IndexedDbRepository } from "./storage/indexedDbRepository";
import { requestPersistentStorage } from "./storage/repository";

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const repository = new IndexedDbRepository();
const packStore = new OpfsPackStore();
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

function readImage(personaId: string, item: AttachmentItem): Promise<Blob | null> {
  return readAttachment(packStore, personaId, item);
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
  const [hasOlder, setHasOlder] = useState(false);
  const [session, setSession] = useState<PersonaSession | null>(null);
  /** What a running Metabolism is doing, per persona: it outlives the response and the screen it started on. */
  const [metabolismText, setMetabolismText] = useState<Record<string, string>>({});
  const [memoryRevision, setMemoryRevision] = useState(0);
  const [resumingImport, setResumingImport] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [chatStatus, setChatStatus] = useState<{ text: string; tone: ChatStatusTone }>({ text: "", tone: "info" });
  const [sending, setSending] = useState(false);
  const [dataBusy, setDataBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [chatError, setChatError] = useState<ChatErrorPresentation | null>(null);
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [wizard, setWizard] = useState<"full" | "consent" | null>(null);

  const [engineStatus, setEngineStatus] = useState<LiteRtEngineStatus>(() => getEngineStatus());

  const selectedPersona = personas.find((persona) => persona.id === selectedPersonaId) ?? personas[0];
  const activeThread = threads.find((thread) => thread.id === activeThreadId) ?? null;
  const selectedPersonaIdRef = useRef(selectedPersonaId);
  const activeThreadIdRef = useRef(activeThreadId);
  selectedPersonaIdRef.current = selectedPersonaId;
  activeThreadIdRef.current = activeThreadId;
  /** How many rows are on the screen, so a refresh does not drop what the user read back to. */
  const loadedRowsRef = useRef(0);
  const threadLoadRef = useRef(0);
  const selectedSession = session?.personaId === selectedPersona?.id ? session : null;
  const importing = selectedSession?.importState === "importing";

  // 端末内モデル (litert-local) を使うペルソナだけ、選ばれた時点で Engine の読み込みを
  // 先に始めておく (画面はブロックしない — 完了は engineStatus の購読で知る)。
  const selectedPersonaProvider = providers.find((provider) => provider.id === selectedPersona?.providerId);
  useEffect(() => {
    if (!selectedPersona || selectedPersonaProvider?.kind !== "litert-local") return;
    if (!isLiteRtModelId(selectedPersona.model)) return;
    void ensureEngine(selectedPersona.model).catch((error) => {
      console.error("[SAIVerse Lite][llm] failed to pre-load local model", { modelId: selectedPersona.model, error });
    });
    // selectedPersonaProvider は依存に入れない: プロバイダ一覧が再取得されるたびに参照が
    // 変わるが、ペルソナ・モデルが同じなら ensureEngine() 側で既読エンジンを再利用するだけで
    // 実害はない。ここではペルソナ/モデルの切り替えだけを再読み込みの契機にする。
  }, [selectedPersona?.id, selectedPersona?.model]);

  // 購読を張る前に状態が動いていることがある (上の先読み effect がこの effect より先に走り、
  // ensureEngine() が同期的に loading を通知してしまう)。登録した瞬間に現在値を取り直さないと、
  // 「読み込み中」の通知だけを聞き逃し、待っている間ずっと何も表示されない。
  useEffect(() => {
    setEngineStatus(getEngineStatus());
    return subscribeLiteRtEngine(setEngineStatus);
  }, []);

  // 「今見ているペルソナが端末内モデルを使っていて、かつ engine が扱っているのがそのモデルか」
  // が一致するときだけ ChatView へ状態を渡す。無関係なペルソナを見ているときに裏の読み込み状況を
  // 出すと利用者が混乱するため、関係なければ null にする。
  const localModelStatus = selectedPersona && selectedPersonaProvider?.kind === "litert-local"
    && isLiteRtModelId(selectedPersona.model) && engineStatus.modelId === selectedPersona.model
    ? engineStatus
    : null;
  const retryLocalModel = () => {
    if (!selectedPersona || !isLiteRtModelId(selectedPersona.model)) return;
    void ensureEngine(selectedPersona.model).catch((error) => {
      console.error("[SAIVerse Lite][llm] retry to load local model failed", { modelId: selectedPersona.model, error });
    });
  };

  const loadThread = useCallback(async (threadId: string | null) => {
    const load = threadLoadRef.current + 1;
    threadLoadRef.current = load;
    const sameThread = threadId === activeThreadIdRef.current;
    setActiveThreadId(threadId);
    const page = threadId
      ? await readLatestRows(repository, threadId, sameThread ? Math.max(MESSAGE_PAGE_ROWS, loadedRowsRef.current) : MESSAGE_PAGE_ROWS)
      : { rows: [], hasOlder: false };
    if (threadLoadRef.current !== load) return;
    loadedRowsRef.current = page.rows.length;
    setMessages(page.rows);
    setHasOlder(page.hasOlder);
  }, []);

  /** Opening a thread is what continues it, so the session follows whatever the screen shows. */
  const continueInThread = useCallback(async (personaId: string, threadId: string): Promise<PersonaSession | null> => {
    const persona = await repository.getPersona(personaId);
    return persona ? activateThread(repository, persona, threadId) : null;
  }, []);

  const loadPersonaData = useCallback(async (personaId: string, preferredThreadId?: string) => {
    let current = await repository.getSession(personaId) ?? null;
    const stopped = current?.importState === "importing";
    let nextThreads = (await repository.listThreads(personaId)).filter((thread) => !thread.stelis);
    // A stopped import owns the persona's rows until it finishes.
    if (nextThreads.length === 0 && !stopped) {
      const now = Date.now();
      const thread: ConversationThread = { id: newId("thread"), personaId, title: "新しい会話", createdAt: now, updatedAt: now };
      await repository.putThread(thread);
      nextThreads = [thread];
    }
    setThreads(nextThreads);
    setSession(current);
    const nextThreadId = [preferredThreadId, current?.activeThreadId, nextThreads[0]?.id]
      .find((id) => id && nextThreads.some((thread) => thread.id === id)) ?? null;
    await loadThread(nextThreadId);
    if (!nextThreadId || nextThreadId === current?.activeThreadId) return;
    try {
      current = await continueInThread(personaId, nextThreadId);
      if (selectedPersonaIdRef.current === personaId) setSession(current);
    } catch (error) {
      // The next response settles the same thing, so the thread stays open.
      console.error("[SAIVerse Lite][chat] thread could not be made active", { personaId, threadId: nextThreadId, error });
    }
  }, [continueInThread, loadThread]);

  const refreshBase = useCallback(async (preferredPersonaId?: string, preferredThreadId?: string) => {
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
    if (nextPersonaId) await loadPersonaData(nextPersonaId, preferredThreadId);
  }, [loadPersonaData]);

  useEffect(() => {
    void (async () => {
      try {
        await repository.initialize();
        const persisted = await requestPersistentStorage();
        const current = await repository.getSettings();
        if (current.storagePersisted !== persisted) await repository.putSettings({ ...current, storagePersisted: persisted });
        await refreshBase();
        // 初回導線の起動判定。会話実績のある既存利用者には full ウィザードを出さない。
        const onboarding = loadOnboarding();
        const consentOk = current.consentVersion === LEGAL_VERSION;
        if (!onboarding.completed) {
          let hasHistory = false;
          for (const persona of await repository.listPersonas()) {
            for (const thread of await repository.listThreads(persona.id)) {
              if ((await repository.readThreadMessages(thread.id, { direction: "forward", limit: 1 })).length > 0) { hasHistory = true; break; }
            }
            if (hasHistory) break;
          }
          if (hasHistory) {
            completeOnboarding(); // 既存利用者は次回以降この走査をしない
            if (!consentOk) setWizard("consent");
          } else {
            setWizard("full");
          }
        } else if (!consentOk) {
          setWizard("consent");
        }
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
      document.querySelector('meta[name="theme-color"]')?.setAttribute("content", resolved === "dark" ? "#0a0a0a" : "#fdfdfd");
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [settings.theme]);

  const selectPersona = async (id: string) => {
    setSelectedPersonaId(id);
    await loadPersonaData(id);
  };

  const selectThread = async (id: string) => {
    if (!selectedPersona) return;
    const personaId = selectedPersona.id;
    try {
      await loadThread(id);
      const next = await continueInThread(personaId, id);
      if (selectedPersonaIdRef.current === personaId) setSession(next);
    } catch (error) {
      console.error("[SAIVerse Lite][chat] Failed to open thread", { threadId: id, error });
      setNotice(`会話を開けませんでした: ${errorMessage(error)}`);
    }
  };

  const loadOlderMessages = async () => {
    const threadId = activeThreadId;
    const oldest = messages[0];
    if (!threadId || !oldest) return;
    try {
      const page = await readOlderRows(repository, threadId, oldest);
      if (activeThreadIdRef.current !== threadId) return;
      loadedRowsRef.current += page.rows.length;
      setMessages((current) => [...page.rows, ...current]);
      setHasOlder(page.hasOlder);
    } catch (error) {
      console.error("[SAIVerse Lite][chat] Failed to read older rows", { threadId, error });
      setNotice(`前の発言を読み込めませんでした: ${errorMessage(error)}`);
    }
  };

  const refreshConversation = async (expectedPersonaId: string, expectedThreadId: string) => {
    if (selectedPersonaIdRef.current !== expectedPersonaId || activeThreadIdRef.current !== expectedThreadId) return;
    await loadPersonaData(expectedPersonaId, expectedThreadId);
  };

  const trackMetabolism = (personaId: string) => (state: MetabolismState) => {
    setMetabolismText((current) => {
      if (state.running) return { ...current, [personaId]: state.text };
      const { [personaId]: _finished, ...rest } = current;
      return rest;
    });
    if (state.running) return;
    setMemoryRevision((revision) => revision + 1);
    void repository.getSession(personaId).then((next) => {
      if (selectedPersonaIdRef.current === personaId) setSession(next ?? null);
    }).catch((error: unknown) => console.error("[SAIVerse Lite][chat] session could not be reloaded after Metabolism", { personaId, error }));
  };

  const dismissMetabolismNotice = async () => {
    if (!selectedPersona) return;
    try {
      setSession(await repository.updateSession(selectedPersona.id, (current) => ({ ...current, metabolismNotice: null })));
    } catch (error) {
      console.error("[SAIVerse Lite][chat] Metabolism notice could not be closed", error);
      setNotice(`通知を閉じられませんでした: ${errorMessage(error)}`);
    }
  };

  const createThread = async () => {
    if (!selectedPersona) return;
    const now = Date.now();
    const thread: ConversationThread = { id: newId("thread"), personaId: selectedPersona.id, title: "新しい会話", createdAt: now, updatedAt: now };
    await repository.putThread(thread);
    await loadPersonaData(selectedPersona.id, thread.id);
  };

  const deleteThreads = async (ids: string[]): Promise<boolean> => {
    if (!selectedPersona || sending) return false;
    const requestedIds = new Set(ids);
    const targets = threads.filter((thread) => requestedIds.has(thread.id));
    if (targets.length === 0 || !window.confirm(`${targets.length}件の会話を削除しますか？\n選んだ会話の発言は元に戻せません。`)) return false;
    try {
      await repository.deleteThreads(targets.map((thread) => thread.id));
      for (const target of targets) saveDraft(`composer.${target.id}`, "");
      await loadPersonaData(selectedPersona.id);
      setNotice(`${targets.length}件の会話を削除しました。`);
      return true;
    } catch (error) {
      console.error("[SAIVerse Lite][storage] Failed to delete threads", { threadIds: targets.map((thread) => thread.id), error });
      setNotice(`${targets.length}件の会話を削除できませんでした: ${errorMessage(error)}`);
      return false;
    }
  };

  const send = async (text: string): Promise<boolean> => {
    if (!selectedPersona || !activeThread) return false;
    setSending(true);
    setStreamingText("");
    setNotice("");
    setChatError(null);
    try {
      try {
        await chatService.send(selectedPersona, activeThread, text, {
          onDelta: (delta) => {
            if (activeThreadIdRef.current === activeThread.id && selectedPersonaIdRef.current === selectedPersona.id) setStreamingText((current) => current + delta);
          },
          onStatus: (text, tone) => {
            if (activeThreadIdRef.current === activeThread.id && selectedPersonaIdRef.current === selectedPersona.id) setChatStatus({ text, tone: tone ?? "info" });
          },
          onUserMessageStored: (message) => {
            if (activeThreadIdRef.current === message.threadId && selectedPersonaIdRef.current === message.personaId) {
              setMessages((current) => current.some((item) => item.id === message.id) ? current : [...current, message]);
            }
          },
          onMetabolism: trackMetabolism(selectedPersona.id),
        });
      } catch (error) {
        console.error("[SAIVerse Lite][chat] send failed", error);
        setChatError(presentChatError(error, "send"));
        try {
          await refreshConversation(selectedPersona.id, activeThread.id);
        } catch (refreshError) {
          console.error("[SAIVerse Lite][chat] refresh after failed send also failed", refreshError);
        }
        // A kept turn is in the history already; the composer getting the text back would send it twice.
        return error instanceof ChatOperationError && error.keptTurn;
      }
      try {
        await refreshConversation(selectedPersona.id, activeThread.id);
      } catch (refreshError) {
        console.error("[SAIVerse Lite][chat] send succeeded but refresh failed", refreshError);
        setNotice("送信は完了しましたが、画面の更新に失敗しました。アプリを開き直すと保存済みの会話を読み込めます。");
      }
      return true;
    } finally {
      setSending(false);
      setStreamingText("");
      setChatStatus({ text: "", tone: "info" });
    }
  };

  const editMessage = async (message: ChatMessage, content: string) => {
    try {
      if (message.role === "user" && await hasRowsAfter(repository, message)) {
        if (!window.confirm("この発言より後の会話はすべて削除されます。元に戻せません。続けますか？")) return;
        await deleteRowsAfter(repository, message);
      }
      await repository.putMessage(await withoutPassphrase(repository, { ...message, content, editedAt: Date.now() }));
      await loadThread(message.threadId);
    } catch (error) {
      console.error("[SAIVerse Lite][chat] Failed to edit message", { messageId: message.id, error });
      setNotice(`発言を編集できませんでした: ${errorMessage(error)}`);
    }
  };

  const deleteMessage = async (message: ChatMessage) => {
    if (sending) return;
    const speaker = message.role === "user" ? settings.userName.trim() || "あなた" : selectedPersona?.name || "AI";
    if (!window.confirm(`${speaker}のこの発言だけを削除しますか？\nこの操作は元に戻せません。`)) return;
    try {
      await repository.deleteMessage(message.id);
      await loadThread(message.threadId);
      setNotice(`${speaker}の発言を削除しました。`);
    } catch (error) {
      console.error("[SAIVerse Lite][chat] Failed to delete message", { messageId: message.id, error });
      setNotice(`発言を削除できませんでした: ${errorMessage(error)}`);
    }
  };

  const regenerate = async () => {
    if (!selectedPersona || !activeThreadId || sending) return;
    setSending(true);
    setStreamingText("");
    setChatError(null);
    try {
      try {
        await chatService.regenerate(selectedPersona, activeThreadId, {
          onDelta: (delta) => {
            if (activeThreadIdRef.current === activeThreadId && selectedPersonaIdRef.current === selectedPersona.id) setStreamingText((current) => current + delta);
          },
          onStatus: (text, tone) => {
            if (activeThreadIdRef.current === activeThreadId && selectedPersonaIdRef.current === selectedPersona.id) setChatStatus({ text, tone: tone ?? "info" });
          },
          onMetabolism: trackMetabolism(selectedPersona.id),
        });
      } catch (error) {
        console.error("[SAIVerse Lite][chat] regenerate failed", error);
        setChatError(presentChatError(error, "regenerate"));
        try {
          await refreshConversation(selectedPersona.id, activeThreadId);
        } catch (refreshError) {
          console.error("[SAIVerse Lite][chat] refresh after failed regeneration also failed", refreshError);
        }
        return;
      }
      try {
        await refreshConversation(selectedPersona.id, activeThreadId);
      } catch (refreshError) {
        console.error("[SAIVerse Lite][chat] regeneration succeeded but refresh failed", refreshError);
        setNotice("再生成は完了しましたが、画面の更新に失敗しました。アプリを開き直すと保存済みの返答を読み込めます。");
      }
    } finally {
      setSending(false); setStreamingText(""); setChatStatus({ text: "", tone: "info" });
    }
  };

  const savePersona = async (persona: Persona) => { await repository.putPersona(persona); await refreshBase(persona.id); };
  const deletePersona = async (id: string) => {
    if (!window.confirm("このパートナーと端末内の会話・記憶を削除しますか？")) return;
    // A Metabolism still running would write pages for a persona that no longer exists.
    await chatService.whenSettled(id);
    await repository.deletePersona(id);
    await packStore.delete(id).catch((error: unknown) => console.warn("[SAIVerse Lite][pack] stored pack could not be deleted", { personaId: id, error }));
    await refreshBase();
  };

  const exportCurrentMemory = async () => {
    if (!selectedPersona) return;
    const snapshot = await repository.exportSnapshot();
    const value = exportSaiverseMemory(selectedPersona, snapshot.threads, snapshot.messages, snapshot.pages);
    downloadJson(`${selectedPersona.id}_saiverse-memory.json`, value);
  };

  const importPack = async (file: File, providerId: string, model: string, onProgress: (progress: PackImportProgress) => void) => {
    setDataBusy(true);
    setNotice("");
    try {
      const result = await importPersonaPack(file, repository, packStore, { providerId, model, resolveInitialAnchor }, onProgress);
      await refreshBase(result.personaId, result.activeThreadId ?? undefined);
      return result;
    } catch (error) {
      // A stopped import leaves its persona in the list.
      await refreshBase(selectedPersonaIdRef.current);
      throw error;
    } finally {
      setDataBusy(false);
    }
  };
  const listInterruptedImports = async () => {
    const sessions = await Promise.all(personas.map((persona) => repository.getSession(persona.id)));
    return personas.filter((_, index) => sessions[index]?.importState === "importing").map((persona) => persona.name);
  };

  const runDataAction = async (action: () => Promise<string>) => {
    setDataBusy(true); setNotice("");
    try { setNotice(await action()); } catch (error) { console.error("[SAIVerse Lite][data] action failed", error); setNotice(`処理できませんでした: ${errorMessage(error)}`); }
    finally { setDataBusy(false); }
  };

  const content = (() => {
    if (!selectedPersona) return <div className="empty-state"><h2>パートナーを読み込めませんでした</h2></div>;
    if (view === "chat") return <ChatView persona={selectedPersona} settings={settings} threads={threads} activeThreadId={activeThreadId} messages={messages} hasOlder={hasOlder} importing={importing} importBusy={dataBusy} metabolismText={metabolismText[selectedPersona.id] ?? ""} metabolismError={selectedSession?.metabolismError ?? null} metabolismNotice={selectedSession?.metabolismNotice ?? null} streamingText={streamingText} status={chatStatus.text} statusTone={chatStatus.tone} sending={sending} localModelStatus={localModelStatus} onRetryLocalModel={retryLocalModel} onSelectThread={(id) => void selectThread(id)} onCreateThread={() => void createThread()} onDeleteThreads={deleteThreads} onSend={send} onEdit={editMessage} onDeleteMessage={deleteMessage} onRegenerate={regenerate} onLoadOlder={loadOlderMessages} onResumeImport={() => setResumingImport(true)} onDismissMetabolismNotice={() => void dismissMetabolismNotice()} onReadImage={readImage} />;
    if (view === "personas") return <PersonaView personas={personas} providers={providers} selectedId={selectedPersona.id} onSelect={(id) => void selectPersona(id)} onSave={savePersona} onDelete={deletePersona} />;
    if (view === "memory") {
      return importing
        ? <section className="view content-view"><ImportResumePanel personaName={selectedPersona.name} busy={dataBusy} onResume={() => setResumingImport(true)} /></section>
        : <MemoryView key={selectedPersona.id} persona={selectedPersona} repository={repository} revision={memoryRevision} />;
    }
    if (view === "data") return <DataView
      persona={selectedPersona} personas={personas} providers={providers} busy={dataBusy} notice={notice}
      onImportPack={importPack}
      listInterruptedImports={listInterruptedImports}
      onExportPersona={() => downloadJson(`${selectedPersona.id}_persona.json`, exportPersona(selectedPersona))}
      onExportMemory={exportCurrentMemory}
      onExportBackup={() => runDataAction(async () => { downloadJson("saiverse-lite-backup.json", exportFullBackup(await repository.exportSnapshot())); return "フルバックアップを書き出しました。"; })}
      onImportBackup={(file) => runDataAction(async () => { if (!window.confirm("現在の端末内データをバックアップ内容で置き換えますか？")) return "復元をキャンセルしました。"; await Promise.all(personas.map((persona) => chatService.whenSettled(persona.id))); await repository.replaceSnapshot(parseFullBackup(JSON.parse(await file.text()))); await refreshBase(); return "バックアップを復元しました。APIキーは再入力してください。"; })}
      onImportNative={(file) => runDataAction(async () => { const imported = importSaiverseMemory(JSON.parse(await file.text()), selectedPersona.id); await saveSaiverseMemoryImport(repository, selectedPersona.id, imported); await loadPersonaData(selectedPersona.id); return `${imported.threads.length}スレッド、${imported.messages.length}発言、${imported.memories.length}記憶を取り込みました。`; })}
      onImportOfficial={async (target: ConversationImportTarget, conversations: ImportedConversation[], memories: ClaudeMemoryText[]) => {
        setDataBusy(true);
        setNotice("");
        let createdPersonaId: string | null = null;
        const sourceName = conversations[0]?.source === "claude" ? "Claude" : "ChatGPT";
        try {
          let targetPersona: Persona | undefined;
          if (target.kind === "existing") {
            targetPersona = personas.find((persona) => persona.id === target.personaId) ?? await repository.getPersona(target.personaId);
            if (!targetPersona) throw new Error("取り込み先のパートナーが見つかりません");
          } else {
            const now = Date.now();
            targetPersona = {
              id: newId("persona"),
              ...target.persona,
              avatarDataUrl: null,
              toolIds: ["memory_recall", "image_generate"],
              createdAt: now,
              updatedAt: now,
            };
            await repository.putPersona(targetPersona);
            createdPersonaId = targetPersona.id;
            console.log("[SAIVerse Lite][import] new persona created for official import", { source: sourceName, personaId: targetPersona.id, conversations: conversations.length });
          }
          const result = await saveImportedConversations(repository, targetPersona, conversations);
          const memoryCount = memories.length ? await saveClaudeMemories(repository, targetPersona, memories) : 0;
          await refreshBase(targetPersona.id);
          const memoryNote = memoryCount ? `、Claude の記憶 ${memoryCount}件` : "";
          setNotice(`${targetPersona.name}へ${result.threads}会話、${result.messages}発言${memoryNote}を取り込みました。`);
          return true;
        } catch (error) {
          console.error("[SAIVerse Lite][import] selected official import failed", { source: sourceName, error });
          if (createdPersonaId) {
            try {
              await repository.deletePersona(createdPersonaId);
              console.info("[SAIVerse Lite][import] rolled back new persona after failed import", { personaId: createdPersonaId });
            } catch (rollbackError) {
              console.error("[SAIVerse Lite][import] failed to roll back new persona", { personaId: createdPersonaId, rollbackError });
            }
          }
          setNotice(`${sourceName} の会話を取り込めませんでした: ${errorMessage(error)}`);
          return false;
        } finally {
          setDataBusy(false);
        }
      }}
    />;
    return <SettingsView providers={providers} settings={settings} canInstall={installPrompt !== null} onRestartOnboarding={() => { resetOnboarding(); setWizard("full"); }} onInstall={async () => { if (!installPrompt) return; await installPrompt.prompt(); const choice = await installPrompt.userChoice; if (choice.outcome === "accepted") setInstallPrompt(null); }} onSaveProvider={async (provider) => { await repository.putProvider(provider); setProviders(await repository.listProviders()); }} onDeleteProvider={async (id) => {
      const users = personas.filter((persona) => persona.providerId === id);
      if (users.length) { setNotice(`${users.map((persona) => persona.name).join("、")}が使用中のため削除できません。`); return; }
      await repository.deleteProvider(id); setProviders(await repository.listProviders());
    }} onSaveSettings={async (value) => {
      await repository.putSettings(value);
      setSettings(value);
      console.log("[SAIVerse Lite][settings] app settings saved", { hasUserName: Boolean(value.userName), hasUserAvatar: Boolean(value.userAvatarDataUrl), theme: value.theme });
    }} />;
  })();

  if (loading) return <main className="loading-screen"><div className="brand-mark"><img src={logoUrl} alt="" /></div><h1>SAIVerse Lite</h1><p>部屋を整えています…</p></main>;

  if (wizard) {
    return <OnboardingWizard
      repository={repository}
      onImportPack={(file, onProgress) => importPack(file, "provider_mock", "mock-friendly", onProgress)}
      consentAlreadyGiven={settings.consentVersion === LEGAL_VERSION}
      consentOnly={wizard === "consent"}
      onConsent={async () => {
        const current = await repository.getSettings();
        const next = { ...current, consentVersion: LEGAL_VERSION, consentAt: Date.now() };
        await repository.putSettings(next);
        setSettings(next);
      }}
      onFinished={async (personaId) => {
        setWizard(null);
        await refreshBase(personaId ?? undefined);
        setView("chat");
      }}
    />;
  }
  return (
    <div className="app-shell">
      <Nav active={view} onChange={setView} online={online} />
      <main className="main-stage">
        {chatError && view === "chat" && <ChatErrorNotice error={chatError} onClose={() => setChatError(null)} />}
        {notice && view !== "data" && <div className="global-notice" role="alert"><span>{notice}</span><button className="notice-close" onClick={() => setNotice("")} aria-label="閉じる">×</button></div>}
        {content}
      </main>
      {resumingImport && selectedPersona && <PackImportDialog providers={providers} defaultProviderId={selectedPersona.providerId} defaultModel={selectedPersona.model} interruptedNames={[selectedPersona.name]} onImport={importPack} onClose={() => setResumingImport(false)} />}
    </div>
  );
}
