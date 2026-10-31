import { useState } from "react";
import { Undo2 } from "lucide-react";
import type { Persona } from "../domain";
import type { PackExportProgress, PackExportResult, PackExportStage } from "../pack/exportPack";
import { PackError } from "../pack/format";
import { savePackFile } from "../pack/savePack";

const STAGE_LABELS: Record<PackExportStage, string> = {
  threads: "会話を書き出しています",
  messages: "発言を書き出しています",
  pages: "記憶を書き出しています",
  fragments: "記憶の断片を書き出しています",
  profile: "プロフィールを書き出しています",
  images: "画像を書き出しています",
  files: "残りのファイルを写しています",
  finishing: "仕上げています",
};

interface PackExportCardProps {
  persona: Persona;
  busy: boolean;
  onExport(onProgress: (progress: PackExportProgress) => void): Promise<PackExportResult>;
}

function progressText({ stage, done, total }: PackExportProgress): string {
  if (total) return `${STAGE_LABELS[stage]}（${done} / ${total}）`;
  return done ? `${STAGE_LABELS[stage]}（${done}件）` : STAGE_LABELS[stage];
}

export function PackExportCard({ persona, busy, onExport }: PackExportCardProps) {
  const [progress, setProgress] = useState<PackExportProgress | null>(null);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<PackExportResult | null>(null);
  const [error, setError] = useState("");

  const start = async () => {
    setRunning(true);
    setResult(null);
    setError("");
    setProgress(null);
    try {
      setResult(await onExport(setProgress));
    } catch (exportError) {
      console.error("[SAIVerse Lite][pack] export failed", { personaId: persona.id, error: exportError });
      setError(exportError instanceof PackError ? exportError.message : "書き出しに失敗しました。もう一度押してください。");
    } finally {
      setRunning(false);
      setProgress(null);
    }
  };
  const save = async () => {
    if (!result) return;
    setError("");
    try {
      await savePackFile(result.file, result.fileName);
    } catch (saveError) {
      console.error("[SAIVerse Lite][pack] saving failed", { personaId: persona.id, error: saveError });
      setError("保存できませんでした。もう一度押してください。");
    }
  };

  return (
    <article className="panel data-card">
      <span className="card-icon" aria-hidden="true"><Undo2 size={20} strokeWidth={1.8} /></span>
      <h2>本体へ帰す</h2>
      {result
        ? <p>保存した ZIP を、本体の記憶の画面の引っ越しタブで{persona.name}に合流させてください。</p>
        : <p>{persona.name}のこの端末での会話と記憶を、本体へ戻せる ZIP に書き出します。</p>}
      {result?.warnings.map((warning) => <p key={warning} className="field-help">{warning}</p>)}
      {running && <div className="field" role="status">
        <span>{progress ? progressText(progress) : "準備しています"}</span>
        <progress style={{ width: "100%", accentColor: "var(--accent)" }} {...(progress?.total ? { max: progress.total, value: progress.done } : {})} />
      </div>}
      {error && <div className="notice" role="alert">{error}</div>}
      <div className="button-stack">
        {result && <button className="button" onClick={() => void save()} disabled={running}>ZIP を保存</button>}
        <button className={result ? "button secondary" : "button"} onClick={() => void start()} disabled={busy || running}>{running ? "書き出し中…" : result ? "書き出し直す" : "書き出す"}</button>
      </div>
    </article>
  );
}
