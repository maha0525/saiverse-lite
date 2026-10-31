import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { ChatStatusTone } from "../chatService";
import { HANDY_TOOL_NOTICE, SYSTEM_NOTICE_KEY, type AppSettings, type ChatMessage, type ConversationThread, type Persona } from "../domain";
import { formatLoadingElapsedMessage, type LiteRtEngineStatus } from "../llm/litertEngine";
import { loadDraft, saveDraft } from "../onboarding";
import { ThreadManagerDialog } from "./ThreadManagerDialog";

interface ChatViewProps {
  persona: Persona;
  settings: AppSettings;
  threads: ConversationThread[];
  activeThreadId: string | null;
  messages: ChatMessage[];
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
}

function time(value: number): string {
  return new Intl.DateTimeFormat("ja-JP", { hour: "2-digit", minute: "2-digit" }).format(value);
}

function MessageBubble({ message, persona, settings, disabled, onEdit, onDelete }: { message: ChatMessage; persona: Persona; settings: AppSettings; disabled: boolean; onEdit(message: ChatMessage, content: string): Promise<void>; onDelete(message: ChatMessage): Promise<void> }) {
  const imageDataUrl = typeof message.metadata.imageDataUrl === "string" ? message.metadata.imageDataUrl : null;
  if (message.role === "system" || message.role === "host") {
    const handyTool = message.metadata[SYSTEM_NOTICE_KEY] === HANDY_TOOL_NOTICE;
    const summary = !handyTool ? "システムの記録" : message.content.startsWith("[Handy Tool: image_generate]") ? "画像を生成しました" : "記憶を確認しました";
    return (
      <details className="tool-result">
        <summary>{summary}</summary>
        {imageDataUrl && <img src={imageDataUrl} alt="AIがツールで生成した画像" />}
        <pre>{message.content}</pre>
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
        <div className="message-content">{message.content || <span className="muted">ツールを使っています…</span>}</div>
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
  const bottomRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const activeThreadRef = useRef(props.activeThreadId);
  activeThreadRef.current = props.activeThreadId;
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [props.messages, props.streamingText]);
  useEffect(() => { setThreadManagerOpen(false); }, [props.persona.id]);

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
  return (
    <section className="view chat-view" aria-labelledby="chat-title">
      <header className="view-header chat-header">
        <div className="persona-heading">
          <div className="large-avatar">{props.persona.avatarDataUrl ? <img src={props.persona.avatarDataUrl} alt="" /> : props.persona.name.slice(0, 1)}</div>
          <div><h1 id="chat-title">{props.persona.name}</h1><p>{props.persona.description}</p></div>
        </div>
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
      <div className="message-list" aria-live="polite">
        {props.messages.length === 0 && !props.streamingText && (
          <div className="empty-state"><span>ここから始まる</span><h2>{props.persona.name}との新しい時間</h2><p>会話も記憶も、この端末の中に保存されます。</p></div>
        )}
        {props.messages.map((message) => <MessageBubble key={message.id} message={message} persona={props.persona} settings={props.settings} disabled={props.sending} onEdit={props.onEdit} onDelete={props.onDeleteMessage} />)}
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
          <button className="text-button" onClick={() => void props.onRegenerate()} disabled={props.sending || localModelLoading || props.messages.every((message) => message.role !== "assistant")}>最後の返答を再生成</button>
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
