import { X } from "lucide-react";
import type { LegalDocument } from "../legal";

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
            <p>{section.body}</p>
          </section>
        ))}
      </div>
    </div>
  );
}
