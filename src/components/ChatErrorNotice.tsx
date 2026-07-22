import { useState } from "react";
import type { ChatErrorPresentation } from "../chatErrors";

interface ChatErrorNoticeProps {
  error: ChatErrorPresentation;
  onClose(): void;
}

export function ChatErrorNotice({ error, onClose }: ChatErrorNoticeProps) {
  const [copyStatus, setCopyStatus] = useState("");
  const copyDetail = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable");
      await navigator.clipboard.writeText(error.detail);
      setCopyStatus("コピーしました");
    } catch {
      setCopyStatus("詳細を長押ししてコピーしてください");
    }
  };

  return (
    <aside className="global-notice chat-error-notice" role="alert" aria-live="assertive">
      <div className="notice-body">
        <strong className="notice-title">{error.title}</strong>
        <p className="notice-message">{error.message}</p>
        <details className="notice-details">
          <summary>技術的な詳細（サポート用）</summary>
          <pre>{error.detail}</pre>
          <div className="notice-detail-actions">
            <button type="button" className="text-button" onClick={() => void copyDetail()}>詳細をコピー</button>
            {copyStatus && <span role="status">{copyStatus}</span>}
          </div>
        </details>
      </div>
      <button type="button" className="notice-close" onClick={onClose} aria-label="閉じる">×</button>
    </aside>
  );
}
