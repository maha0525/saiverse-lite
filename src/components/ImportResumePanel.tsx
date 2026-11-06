interface ImportResumePanelProps {
  personaName: string;
  busy: boolean;
  onResume(): void;
}

export function ImportResumePanel({ personaName, busy, onResume }: ImportResumePanelProps) {
  return (
    <div className="empty-state import-resume">
      <h2>{personaName}の取り込みが途中で止まっています</h2>
      <p>本体で書き出した同じ ZIP を選ぶと、続きから入ります。終わると話せるようになります。</p>
      <button type="button" className="button" onClick={onResume} disabled={busy}>ZIP を選ぶ</button>
    </div>
  );
}
