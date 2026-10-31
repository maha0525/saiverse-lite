import { X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { ChatStatusTone } from "../chatService";
import { isRegenerable, noticeSummary, rowDisplay } from "../conversationPage";
import type { AppSettings, ChatMessage, ConversationThread, Persona } from "../domain";
import { formatLoadingElapsedMessage, type LiteRtEngineStatus } from "../llm/litertEngine";
import { loadDraft, saveDraft } from "../onboarding";
import { ImportResumePanel } from "./ImportResumePanel";
import { MessageImages, type ReadImage } from "./MessageImages";
import { ThreadManagerDialog } from "./ThreadManagerDialog";

interface ChatViewProps {
  persona: Persona;
  settings: AppSettings;
  threads: ConversationThread[];
  activeThreadId: string | null;
  messages: ChatMessage[];
  /** Older rows of the thread are not on the screen yet. */
  hasOlder: boolean;
  /** The persona's pack import stopped partway, so it cannot be talked to. */
  importing: boolean;
  importBusy: boolean;
  /** What a running Metabolism is doing. Empty when none runs. */
  metabolismText: string;
  metabolismError: string | null;
  metabolismNotice: string | null;
  streamingText: string;
  status: string;
  statusTone: ChatStatusTone;
  sending: boolean;
  /**
   * このペルソナが端末内モデル (litert-local) を使っていて、かつそのモデルの読み込み
   * 状況に関係があるときだけ非 null になる (無関係なペルソナを見ているときは null — 呼び出し元の
   * App.tsx が判定する)。「送信中だから待つ」(sending) とは別の「モデル準備中だから待つ」理由。
   */
  localModelStatus: LiteRtEngineStatus | null;
  onRetryLocalModel(): void;
  onSelectThread(id: string): void;
  onCreateThread(): void;
  onDeleteThreads(ids: string[]): Promise<boolean>;
  onSend(text: string): Promise<boolean>;
  onEdit(message: ChatMessage, content: string): Promise<void>;
  onDeleteMessage(message: ChatMessage): Promise<void>;
  onRegenerate(): Promise<void>;
  onLoadOlder(): Promise<void>;
  onResumeImport(): void;
  onDismissMetabolismNotice(): void;
  onReadImage: ReadImage;
}

function time(value: number): string {
  return new Intl.DateTimeFormat("ja-JP", { hour: "2-digit", minute: "2-digit" }).format(value);
}

function MessageBubble({ message, persona, settings, disabled, onEdit, onDelete, onReadImage }: { message: ChatMessage; persona: Persona; settings: AppSettings; disabled: boolean; onEdit(message: ChatMessage, content: string): Promise<void>; onDelete(message: ChatMessage): Promise<void>; onReadImage: ReadImage }) {
  const display = rowDisplay(message);
  if (display === "hidden") return null;
  if (display === "notice") {
    const imageDataUrl = typeof message.metadata.imageDataUrl === "string" ? message.metadata.imageDataUrl : null;
    return (
      <details className="tool-result">
        <summary>{noticeSummary(message)}</summary>
        {imageDataUrl && <img src={imageDataUrl} alt="AIがツールで生成した画像" />}
        <MessageImages message={message} onReadImage={onReadImage} />
        {message.content && <pre>{message.content}</pre>}
      </details>
    );
  }
  const userName = settings.userName.trim() || "あなた";
  const label = message.role === "user" ? userName : persona.name;
  const edit = () => {
    const next = window.prompt("メッセージを編集", message.content);
    if (next !== null && next.trim() && next !== message.content) void onEdit(message, next.trim());
  };
  return (
    <article className={`message-row ${message.role}`}>
      <div className="message-avatar" aria-hidden="true">
        {message.role === "assistant" && persona.avatarDataUrl
          ? <img src={persona.avatarDataUrl} alt="" />
          : message.role === "user" && settings.userAvatarDataUrl
            ? <img src={settings.userAvatarDataUrl} alt="" />
            : label.slice(0, 1)}
      </div>
      <div className="message-body">
        <div className="message-meta"><strong>{label}</strong><time>{time(message.createdAt)}</time>{message.editedAt && <span>編集済み</span>}</div>
        {message.content.trim() && <div className="message-content">{message.content}</div>}
        <MessageImages message={message} onReadImage={onReadImage} />
        <div className="message-actions">
          <button className="text-button compact" onClick={edit} disabled={disabled}>編集</button>
          <button className="text-button compact danger" onClick={() => void onDelete(message)} disabled={disabled}>削除</button>
        </div>
      </div>
    </article>
  );
}

export function ChatView(props: ChatViewProps) {
  const [draft, setDraft] = useState("");
  const [threadManagerOpen, setThreadManagerOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [loadingOlder, setLoadingOlder] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const activeThreadRef = useRef(props.activeThreadId);
  activeThreadRef.current = props.activeThreadId;
  // Distance from the bottom, kept while older rows are added above what is being read.
  const keptDistance = useRef<number | null>(null);
  const scrolledThread = useRef<string | null>(null);
  const newest = props.messages.at(-1);
  const newestThreadId = newest?.threadId ?? null;
  useEffect(() => {
    // Compared on the rows, not activeThreadId: that changes first, while the old thread's rows are still on the screen.
    const threadChanged = scrolledThread.current !== newestThreadId;
    scrolledThread.current = newestThreadId;
    // A long thread opens at its end, not with a scroll through every row on the way down.
    bottomRef.current?.scrollIntoView({ behavior: threadChanged ? "auto" : "smooth" });
  }, [newestThreadId, newest?.id, props.streamingText]);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (keptDistance.current === null || !list) return;
    list.scrollTop = list.scrollHeight - keptDistance.current;
    keptDistance.current = null;
  }, [props.messages]);
  useEffect(() => { setThreadManagerOpen(false); }, [props.persona.id]);

  const loadOlder = async () => {
    const list = listRef.current;
    if (loadingOlder) return;
    keptDistance.current = list ? list.scrollHeight - list.scrollTop : null;
    setLoadingOlder(true);
    try {
      await props.onLoadOlder();
    } finally {
      setLoadingOlder(false);
    }
  };

  // 端末内モデルの読み込み中だけ、経過秒数の表示を1秒ごとに更新する
  // (進捗率は取得できないため、正直に出せるのは経過時間だけ — docs/gemma4_on_device.md §15.4)。
  const localModelLoading = props.localModelStatus?.status === "loading";
  const localModelLoadingStartedAt = props.localModelStatus?.startedAt;
  useEffect(() => {
    if (!localModelLoading) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [localModelLoading, localModelLoadingStartedAt]);

  // 打ちかけの言葉をスレッドごとに端末へ自動保存 (事故で閉じても消えない)
  useEffect(() => {
    setDraft(props.activeThreadId ? loadDraft(`composer.${props.activeThreadId}`) : "");
  }, [props.activeThreadId]);
  useEffect(() => {
    if (!props.activeThreadId) return;
    const timer = setTimeout(() => saveDraft(`composer.${props.activeThreadId}`, draft), 400);
    return () => clearTimeout(timer);
  }, [draft, props.activeThreadId]);

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    const text = draft.trim();
    const threadId = props.activeThreadId;
    if (!text || props.sending || !threadId) return;
    setDraft("");
    saveDraft(`composer.${threadId}`, "");
    const sent = await props.onSend(text);
    if (!sent) {
      saveDraft(`composer.${threadId}`, text);
      if (activeThreadRef.current === threadId) {
        setDraft(text);
        requestAnimationFrame(() => composerRef.current?.focus());
      }
    }
  };
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  };
  const header = (
    <div className="persona-heading">
      <div className="large-avatar">{props.persona.avatarDataUrl ? <img src={props.persona.avatarDataUrl} alt="" /> : props.persona.name.slice(0, 1)}</div>
      <div><h1 id="chat-title">{props.persona.name}</h1><p>{props.persona.description}</p></div>
    </div>
  );
  if (props.importing) {
    return (
      <section className="view chat-view" aria-labelledby="chat-title">
        <header className="view-header chat-header">{header}</header>
        <div className="message-list"><ImportResumePanel personaName={props.persona.name} busy={props.importBusy} onResume={props.onResumeImport} /></div>
      </section>
    );
  }
  return (
    <section className="view chat-view" aria-labelledby="chat-title">
      <header className="view-header chat-header">
        {header}
        <div className="thread-controls">
          <label>
            <span className="sr-only">スレッド</span>
            <select value={props.activeThreadId ?? ""} onChange={(event) => props.onSelectThread(event.target.value)}>
              {props.threads.map((thread) => <option key={thread.id} value={thread.id}>{thread.title}</option>)}
            </select>
          </label>
          <button className="button secondary" onClick={props.onCreateThread}>新しい会話</button>
          <button className="text-button danger thread-manage-button" disabled={props.sending} onClick={() => setThreadManagerOpen(true)}>会話を整理</button>
        </div>
      </header>
      <div className="message-list" aria-live="polite" ref={listRef}>
        {props.hasOlder && <div className="older-rows"><button type="button" className="text-button" onClick={() => void loadOlder()} disabled={loadingOlder}>{loadingOlder ? "読み込んでいます…" : "前の発言を読み込む"}</button></div>}
        {props.messages.length === 0 && !props.hasOlder && !props.streamingText && (
          <div className="empty-state"><span>ここから始まる</span><h2>{props.persona.name}との新しい時間</h2><p>会話も記憶も、この端末の中に保存されます。</p></div>
        )}
        {props.messages.map((message) => <MessageBubble key={message.id} message={message} persona={props.persona} settings={props.settings} disabled={props.sending} onEdit={props.onEdit} onDelete={props.onDeleteMessage} onReadImage={props.onReadImage} />)}
        {props.streamingText && (
          <article className="message-row assistant streaming">
            <div className="message-avatar" aria-hidden="true">{props.persona.avatarDataUrl ? <img src={props.persona.avatarDataUrl} alt="" /> : props.persona.name.slice(0, 1)}</div>
            <div className="message-body"><div className="message-meta"><strong>{props.persona.name}</strong></div><div className="message-content">{props.streamingText}<span className="cursor" /></div></div>
          </article>
        )}
        {props.status && (
          <div
            className={props.statusTone === "warning" ? "chat-status warning" : "chat-status"}
            role="status"
            aria-live="polite"
          >
            {props.status}
          </div>
        )}
        <div ref={bottomRef} />
      </div>
      <footer className="composer-wrap">
        {props.metabolismText && props.metabolismText !== props.status && <div className="chat-status" role="status" aria-live="polite">{props.metabolismText}</div>}
        {props.metabolismError && <div className="metabolism-notice error" role="alert"><span>{props.metabolismError}</span></div>}
        {props.metabolismNotice && (
          <div className="metabolism-notice" role="status">
            <span>{props.metabolismNotice}</span>
            <button type="button" className="notice-close" onClick={props.onDismissMetabolismNotice} aria-label="閉じる"><X size={15} /></button>
          </div>
        )}
        {localModelLoading && (
          <div className="chat-status warning" role="status" aria-live="polite">
            {formatLoadingElapsedMessage(localModelLoadingStartedAt ?? now, now)}
          </div>
        )}
        {props.localModelStatus?.status === "error" && (
          <div className="chat-status error" role="alert" aria-live="assertive">
            <span>端末内モデルの読み込みに失敗しました：{props.localModelStatus.error ?? "不明なエラー"}</span>
            <button type="button" className="text-button" onClick={props.onRetryLocalModel}>もう一度試す</button>
          </div>
        )}
        <div className="conversation-actions">
          <button className="text-button" onClick={() => void props.onRegenerate()} disabled={props.sending || localModelLoading || !props.messages.some(isRegenerable)}>最後の返答を再生成</button>
        </div>
        <form className="composer" onSubmit={(event) => void submit(event)}>
          <textarea
            ref={composerRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={keyDown}
            placeholder={`${props.persona.name}に話しかける`}
            rows={1}
            disabled={props.sending || localModelLoading || !props.activeThreadId}
            aria-label="メッセージ"
          />
          <button className="send-button" disabled={!draft.trim() || props.sending || localModelLoading || !props.activeThreadId} aria-label="送信">送る</button>
        </form>
      </footer>
      {threadManagerOpen && <ThreadManagerDialog threads={props.threads} busy={props.sending} onClose={() => setThreadManagerOpen(false)} onDelete={props.onDeleteThreads} />}
    </section>
  );
}
