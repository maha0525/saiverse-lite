import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { ChatMessage, ConversationThread, Persona } from "../domain";

interface ChatViewProps {
  persona: Persona;
  threads: ConversationThread[];
  activeThreadId: string | null;
  messages: ChatMessage[];
  streamingText: string;
  status: string;
  sending: boolean;
  onSelectThread(id: string): void;
  onCreateThread(): void;
  onDeleteThread(id: string): void;
  onSend(text: string): Promise<void>;
  onEdit(message: ChatMessage, content: string): Promise<void>;
  onRegenerate(): Promise<void>;
}

function time(value: number): string {
  return new Intl.DateTimeFormat("ja-JP", { hour: "2-digit", minute: "2-digit" }).format(value);
}

function MessageBubble({ message, persona, onEdit }: { message: ChatMessage; persona: Persona; onEdit(message: ChatMessage, content: string): Promise<void> }) {
  const imageDataUrl = typeof message.metadata.imageDataUrl === "string" ? message.metadata.imageDataUrl : null;
  if (message.role === "tool") {
    return (
      <details className="tool-result">
        <summary>{message.toolName === "image_generate" ? "画像を生成しました" : "記憶を確認しました"}</summary>
        {imageDataUrl && <img src={imageDataUrl} alt="AIがツールで生成した画像" />}
        <pre>{message.content}</pre>
      </details>
    );
  }
  const label = message.role === "user" ? "あなた" : persona.name;
  const edit = () => {
    const next = window.prompt("メッセージを編集", message.content);
    if (next !== null && next.trim() && next !== message.content) void onEdit(message, next.trim());
  };
  return (
    <article className={`message-row ${message.role}`}>
      <div className="message-avatar" aria-hidden="true">
        {message.role === "assistant" && persona.avatarDataUrl
          ? <img src={persona.avatarDataUrl} alt="" />
          : label.slice(0, 1)}
      </div>
      <div className="message-body">
        <div className="message-meta"><strong>{label}</strong><time>{time(message.createdAt)}</time>{message.editedAt && <span>編集済み</span>}</div>
        <div className="message-content">{message.content || <span className="muted">ツールを使っています…</span>}</div>
        <button className="text-button compact" onClick={edit}>編集</button>
      </div>
    </article>
  );
}

export function ChatView(props: ChatViewProps) {
  const [draft, setDraft] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [props.messages, props.streamingText]);

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    const text = draft.trim();
    if (!text || props.sending || !props.activeThreadId) return;
    setDraft("");
    await props.onSend(text);
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
          {props.activeThreadId && <button className="text-button danger" onClick={() => props.onDeleteThread(props.activeThreadId!)}>削除</button>}
        </div>
      </header>
      <div className="message-list" aria-live="polite">
        {props.messages.length === 0 && !props.streamingText && (
          <div className="empty-state"><span>ここから始まる</span><h2>{props.persona.name}との新しい時間</h2><p>会話も記憶も、この端末の中に保存されます。</p></div>
        )}
        {props.messages.map((message) => <MessageBubble key={message.id} message={message} persona={props.persona} onEdit={props.onEdit} />)}
        {props.streamingText && (
          <article className="message-row assistant streaming">
            <div className="message-avatar" aria-hidden="true">{props.persona.name.slice(0, 1)}</div>
            <div className="message-body"><div className="message-meta"><strong>{props.persona.name}</strong></div><div className="message-content">{props.streamingText}<span className="cursor" /></div></div>
          </article>
        )}
        {props.status && <div className="chat-status">{props.status}</div>}
        <div ref={bottomRef} />
      </div>
      <footer className="composer-wrap">
        <div className="conversation-actions">
          <button className="text-button" onClick={() => void props.onRegenerate()} disabled={props.sending || props.messages.every((message) => message.role !== "assistant")}>最後の返答を再生成</button>
        </div>
        <form className="composer" onSubmit={(event) => void submit(event)}>
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={keyDown}
            placeholder={`${props.persona.name}に話しかける`}
            rows={1}
            disabled={props.sending || !props.activeThreadId}
            aria-label="メッセージ"
          />
          <button className="send-button" disabled={!draft.trim() || props.sending || !props.activeThreadId} aria-label="送信">送る</button>
        </form>
      </footer>
    </section>
  );
}
