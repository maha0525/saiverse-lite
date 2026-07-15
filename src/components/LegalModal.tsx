import { X } from "lucide-react";
import type { ReactNode } from "react";
import type { LegalDocument } from "../legal";

// 本文中の URL とメールアドレスをクリック可能にする
function linkify(body: string): ReactNode[] {
  return body.split(/(https?:\/\/[^\s、。()]+|[\w.+-]+@[\w-]+\.[\w.-]+)/g).map((part, index) => {
    if (/^https?:\/\//.test(part)) return <a key={index} href={part} target="_blank" rel="noreferrer noopener">{part}</a>;
    if (/^[\w.+-]+@[\w-]+\.[\w.-]+$/.test(part)) return <a key={index} href={`mailto:${part}`}>{part}</a>;
    return part;
  });
}

export function LegalModal({ document, onClose }: { document: LegalDocument; onClose(): void }) {
  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label={document.title} onClick={onClose}>
      <div className="modal-panel" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <h2>{document.title}</h2>
          <button className="modal-close" onClick={onClose} aria-label="閉じる"><X size={18} /></button>
        </div>
        <p className="muted">版: {document.version}</p>
        {document.sections.map((section) => (
          <section key={section.heading}>
            <h3>{section.heading}</h3>
            <p>{linkify(section.body)}</p>
          </section>
        ))}
      </div>
    </div>
  );
}
