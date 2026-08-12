import { useMemo, useState } from "react";
import { X } from "lucide-react";
import type { ConversationThread } from "../domain";

interface ThreadManagerDialogProps {
  threads: ConversationThread[];
  busy: boolean;
  onClose(): void;
  onDelete(ids: string[]): Promise<boolean>;
}

function threadDate(thread: ConversationThread): string {
  return new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short" }).format(thread.updatedAt);
}

export function ThreadManagerDialog(props: ThreadManagerDialogProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [query, setQuery] = useState("");
  const [deleting, setDeleting] = useState(false);
  const locked = props.busy || deleting;
  const visibleThreads = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("ja-JP");
    return normalized
      ? props.threads.filter((thread) => thread.title.toLocaleLowerCase("ja-JP").includes(normalized))
      : props.threads;
  }, [props.threads, query]);
  const selectedCount = props.threads.reduce((count, thread) => count + Number(selectedIds.has(thread.id)), 0);

  const toggle = (id: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const remove = async () => {
    const ids = props.threads.filter((thread) => selectedIds.has(thread.id)).map((thread) => thread.id);
    if (locked || ids.length === 0) return;
    setDeleting(true);
    try {
      if (await props.onDelete(ids)) props.onClose();
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="modal-overlay" role="presentation">
      <section className="modal-panel thread-manager-dialog" role="dialog" aria-modal="true" aria-labelledby="thread-manager-title">
        <div className="modal-head">
          <div><span className="eyebrow">CONVERSATION MANAGER</span><h2 id="thread-manager-title">削除する会話を選ぶ</h2></div>
          <button type="button" className="modal-close" onClick={props.onClose} aria-label="閉じる" disabled={locked}><X size={18} /></button>
        </div>

        <div className="thread-manager-heading">
          <div><strong>会話一覧</strong><small>{selectedCount} / {props.threads.length}件を選択中</small></div>
          <div><button type="button" className="text-button" onClick={() => setSelectedIds(new Set(props.threads.map((thread) => thread.id)))} disabled={locked}>すべて選択</button><button type="button" className="text-button" onClick={() => setSelectedIds(new Set())} disabled={locked}>選択解除</button></div>
        </div>

        <div className="thread-manager-filter">
          <label className="field"><span>会話タイトルを検索</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="削除したい会話を絞り込む" disabled={locked} /></label>
          <button type="button" className="button secondary" disabled={locked || visibleThreads.length === 0} onClick={() => setSelectedIds((current) => new Set([...current, ...visibleThreads.map((thread) => thread.id)]))}>表示中を選択</button>
        </div>

        <div className="thread-manager-list">
          {visibleThreads.map((thread) => (
            <label key={thread.id} className="thread-manager-item">
              <input type="checkbox" checked={selectedIds.has(thread.id)} onChange={() => toggle(thread.id)} disabled={locked} />
              <span><strong>{thread.title}</strong><small>最終更新: {threadDate(thread)}</small></span>
            </label>
          ))}
          {visibleThreads.length === 0 && <p className="field-help">一致する会話がありません。</p>}
        </div>

        <div className="form-actions thread-manager-actions">
          <button type="button" className="button danger-button" onClick={() => void remove()} disabled={locked || selectedCount === 0}>{deleting ? "削除中…" : `選択した${selectedCount}件を削除`}</button>
          <button type="button" className="button secondary" onClick={props.onClose} disabled={locked}>キャンセル</button>
        </div>
      </section>
    </div>
  );
}
