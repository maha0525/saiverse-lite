import { useState } from "react";
import { X } from "lucide-react";
import type { ProviderConfig } from "../domain";
import { PackError, PackFormatError } from "../pack/format";
import type { PackImportProgress, PackImportResult, PackImportStage } from "../pack/importPack";

interface PackImportDialogProps {
  providers: ProviderConfig[];
  defaultProviderId: string;
  /** Given when continuing a persona that already has a model. */
  defaultModel?: string;
  /** Names of the personas whose import stopped partway. */
  interruptedNames: string[];
  onImport(file: File, providerId: string, model: string, onProgress: (progress: PackImportProgress) => void): Promise<PackImportResult>;
  onClose(): void;
}

const STAGE_LABELS: Record<PackImportStage, string> = {
  saving: "ZIP を Lite に保存しています",
  checking: "ZIP の中身を確かめています",
  messages: "会話を読み込んでいます",
  threads: "会話を読み込んでいます",
  pages: "記憶を読み込んでいます",
  fragments: "記憶を読み込んでいます",
  finishing: "仕上げています",
};

const STAGE_STEPS: Record<PackImportStage, number> = { saving: 1, checking: 2, messages: 3, threads: 3, pages: 4, fragments: 4, finishing: 5 };
const LAST_STEP = 5;

function stageDetail({ stage, done, total }: PackImportProgress): string {
  if (!total) return "";
  if (stage === "saving") return `（${Math.floor(done / total * 100)}%）`;
  return `（${done} / ${total}${stage === "checking" ? "項目" : "件"}）`;
}

export function packProgressText(progress: PackImportProgress): string {
  return `${STAGE_STEPS[progress.stage]} / ${LAST_STEP} 段階目: ${STAGE_LABELS[progress.stage]}${stageDetail(progress)}`;
}

/** What the person can do next. The technical reason is in the console. */
export function packFailureText(failure: unknown): string {
  if (failure instanceof PackFormatError) return "このファイルは壊れているか、ペルソナまるごとパックではありません。本体でもう一度書き出して、選び直してください。";
  if (failure instanceof PackError) return failure.message;
  return "取り込みが止まりました。同じ ZIP をもう一度選ぶと、続きから入ります。";
}

export function PackImportDialog(props: PackImportDialogProps) {
  const firstProvider = props.providers.find((provider) => provider.id === props.defaultProviderId) ?? props.providers[0];
  const [file, setFile] = useState<File | null>(null);
  const [providerId, setProviderId] = useState(firstProvider?.id ?? "");
  const [model, setModel] = useState(props.defaultModel || firstProvider?.defaultModel || "");
  const [progress, setProgress] = useState<PackImportProgress | null>(null);
  const [error, setError] = useState("");
  const [result, setResult] = useState<PackImportResult | null>(null);
  const running = progress !== null;

  const start = async () => {
    if (!file) return;
    setError("");
    setProgress({ stage: "saving", done: 0, total: null });
    try {
      setResult(await props.onImport(file, providerId, model.trim(), setProgress));
    } catch (failure) {
      console.error("[SAIVerse Lite][pack] import failed", failure);
      setError(packFailureText(failure));
    } finally {
      setProgress(null);
    }
  };

  return (
    <div className="modal-overlay" role="presentation">
      <section className="modal-panel import-dialog" role="dialog" aria-modal="true" aria-labelledby="pack-import-title">
        <div className="modal-head">
          <div><span className="eyebrow">PERSONA PACK</span><h2 id="pack-import-title">本体のパートナーを連れてくる</h2></div>
          <button type="button" className="modal-close" onClick={props.onClose} aria-label="閉じる" disabled={running}><X size={18} /></button>
        </div>

        {result ? <>
          <div className="notice" role="status">
            {result.personaName}が来ました。会話 {result.threads}件、発言 {result.messages}件、記憶 {result.pages}件を取り込みました。
          </div>
          <p className="import-memory-note">本体の{result.personaName}は動かさないでください。両方で動かすと記憶が分かれます。</p>
          {result.warnings.map((warning) => <p key={warning} className="field-help">{warning}</p>)}
          <div className="form-actions import-dialog-actions"><button type="button" className="button" onClick={props.onClose}>閉じる</button></div>
        </> : <>
          {props.interruptedNames.length > 0 && <p className="import-memory-note">{props.interruptedNames.join("、")}の取り込みが途中で止まっています。同じ ZIP を選ぶと最後まで入ります。</p>}
          <label className="field"><span>本体で書き出したペルソナまるごとパック（ZIP）</span><input type="file" accept="application/zip,.zip" disabled={running} onChange={(event) => { setFile(event.target.files?.[0] ?? null); setError(""); }} /></label>
          <div className="field-grid">
            <label className="field"><span>プロバイダ</span><select value={providerId} disabled={running} onChange={(event) => {
              const provider = props.providers.find((item) => item.id === event.target.value);
              setProviderId(event.target.value);
              setModel(provider?.defaultModel ?? model);
            }}>{props.providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}</option>)}</select></label>
            <label className="field"><span>モデルID</span><input value={model} disabled={running} onChange={(event) => setModel(event.target.value)} /></label>
          </div>
          {progress && <div className="field" role="status">
            <span>{packProgressText(progress)}</span>
            <progress style={{ width: "100%", accentColor: "var(--accent)" }} {...(progress.total ? { max: progress.total, value: progress.done } : {})} />
          </div>}
          {error && <div className="notice" role="alert">{error}</div>}
          <div className="form-actions import-dialog-actions">
            <button type="button" className="button" onClick={() => void start()} disabled={running || !file || !providerId || !model.trim()}>{running ? "取り込み中…" : "取り込む"}</button>
            <button type="button" className="button secondary" onClick={props.onClose} disabled={running}>キャンセル</button>
          </div>
        </>}
      </section>
    </div>
  );
}
