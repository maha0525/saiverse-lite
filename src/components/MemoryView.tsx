import { useState, type FormEvent } from "react";
import type { MemoryEntry, Persona } from "../domain";

interface MemoryViewProps {
  persona: Persona;
  memories: MemoryEntry[];
  onCreate(content: string): Promise<void>;
  onEdit(memory: MemoryEntry, content: string): Promise<void>;
  onDelete(id: string): Promise<void>;
}

export function MemoryView({ persona, memories, onCreate, onEdit, onDelete }: MemoryViewProps) {
  const [draft, setDraft] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft.trim()) return;
    await onCreate(draft.trim());
    setDraft("");
  };
  return (
    <section className="view content-view" aria-labelledby="memory-title">
      <header className="view-header"><div><span className="eyebrow">MEMORY</span><h1 id="memory-title">{persona.name}の記憶</h1><p>自動要約も、あなたが書いた記憶も、ここで見て直せます。</p></div><span className="count-badge">{memories.length}件</span></header>
      <form className="panel memory-compose" onSubmit={(event) => void submit(event)}>
        <label className="field"><span>覚えていてほしいこと</span><textarea value={draft} onChange={(event) => setDraft(event.target.value)} rows={3} placeholder="好み、約束、大切な出来事…" /></label>
        <button className="button" disabled={!draft.trim()}>記憶に加える</button>
      </form>
      <div className="memory-grid">
        {memories.map((memory) => (
          <article className="memory-card" key={memory.id}>
            <div className="memory-card-head"><span className={`memory-kind ${memory.kind}`}>{memory.kind === "summary" ? "自動要約" : "手書き"}</span><time>{new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short" }).format(memory.updatedAt)}</time></div>
            <p>{memory.content}</p>
            <div className="memory-actions">
              <button className="text-button" onClick={() => { const next = window.prompt("記憶を訂正", memory.content); if (next?.trim() && next !== memory.content) void onEdit(memory, next.trim()); }}>訂正</button>
              <button className="text-button danger" onClick={() => void onDelete(memory.id)}>削除</button>
            </div>
          </article>
        ))}
        {memories.length === 0 && <div className="empty-state compact-empty"><h2>まだ記憶はありません</h2><p>会話が続くと自動要約がここに積もります。</p></div>}
      </div>
    </section>
  );
}
