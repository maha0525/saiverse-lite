import { Download, Globe, Import, Smartphone } from "lucide-react";
import type { Persona } from "../domain";

interface DataViewProps {
  persona: Persona;
  busy: boolean;
  notice: string;
  onExportPersona(): void;
  onExportMemory(): Promise<void>;
  onExportBackup(): Promise<void>;
  onImportBackup(file: File): Promise<void>;
  onImportNative(file: File): Promise<void>;
  onImportChatGpt(file: File): Promise<void>;
  onImportClaude(file: File): Promise<void>;
}

function FileAction({ label, accept, disabled, onFile }: { label: string; accept: string; disabled: boolean; onFile(file: File): Promise<void> }) {
  return <label className="button secondary file-button">{label}<input type="file" accept={accept} disabled={disabled} onChange={(event) => { const file = event.target.files?.[0]; if (file) void onFile(file); event.currentTarget.value = ""; }} /></label>;
}

export function DataView(props: DataViewProps) {
  return (
    <section className="view content-view" aria-labelledby="data-title">
      <header className="view-header"><div><span className="eyebrow">PORTABILITY</span><h1 id="data-title">引っ越し</h1><p>関係をこの端末に閉じ込めず、いつでも持ち出せるようにします。</p></div></header>
      {props.notice && <div className="notice" role="status">{props.notice}</div>}
      <div className="data-grid">
        <article className="panel data-card"><span className="card-icon" aria-hidden="true"><Globe size={20} strokeWidth={1.8} /></span><h2>SAIVerse 本体へ</h2><p>{props.persona.name}の定義と、会話・記憶を本体互換形式で分けて書き出します。</p><div className="button-stack"><button className="button" onClick={props.onExportPersona} disabled={props.busy}>ペルソナ定義を保存</button><button className="button secondary" onClick={() => void props.onExportMemory()} disabled={props.busy}>会話+記憶を保存</button></div></article>
        <article className="panel data-card"><span className="card-icon" aria-hidden="true"><Smartphone size={20} strokeWidth={1.8} /></span><h2>端末を移る</h2><p>全ペルソナ・全履歴・設定を一つにまとめます。APIキーだけは含みません。</p><div className="button-stack"><button className="button" onClick={() => void props.onExportBackup()} disabled={props.busy}>フルバックアップ</button><FileAction label="バックアップを復元" accept="application/json,.json" disabled={props.busy} onFile={props.onImportBackup} /></div></article>
        <article className="panel data-card"><span className="card-icon" aria-hidden="true"><Download size={20} strokeWidth={1.8} /></span><h2>本体形式から戻す</h2><p>`saiverse_saimemory_v1` の会話と記憶を、選択中のパートナーへ取り込みます。</p><FileAction label="本体形式を読み込む" accept="application/json,.json" disabled={props.busy} onFile={props.onImportNative} /></article>
        <article className="panel data-card"><span className="card-icon" aria-hidden="true"><Import size={20} strokeWidth={1.8} /></span><h2>これまでの会話を連れてくる</h2><p>ChatGPT の公式 JSON / ZIP に対応。Claude は実物スキーマの検証前なので、推測せず停止します。</p><div className="button-stack"><FileAction label="ChatGPT から" accept="application/json,.json,application/zip,.zip" disabled={props.busy} onFile={props.onImportChatGpt} /><FileAction label="Claude から（検証待ち）" accept="application/json,.json,application/zip,.zip" disabled={props.busy} onFile={props.onImportClaude} /></div></article>
      </div>
    </section>
  );
}
