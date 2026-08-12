import { useState } from "react";
import { Download, Globe, Import, Smartphone } from "lucide-react";
import type { Persona, ProviderConfig } from "../domain";
import { ChatGptExportAdapter, type ImportedConversation } from "../importers";
import { OfficialImportDialog, type ConversationImportTarget } from "./OfficialImportDialog";

interface DataViewProps {
  persona: Persona;
  personas: Persona[];
  providers: ProviderConfig[];
  busy: boolean;
  notice: string;
  onExportPersona(): void;
  onExportMemory(): Promise<void>;
  onExportBackup(): Promise<void>;
  onImportBackup(file: File): Promise<void>;
  onImportNative(file: File): Promise<void>;
  onImportChatGpt(target: ConversationImportTarget, conversations: ImportedConversation[]): Promise<boolean>;
  onImportClaude(file: File): Promise<void>;
}

function FileAction({ label, accept, disabled, onFile }: { label: string; accept: string; disabled: boolean; onFile(file: File): Promise<void> }) {
  return <label className="button secondary file-button">{label}<input type="file" accept={accept} disabled={disabled} onChange={(event) => { const file = event.target.files?.[0]; if (file) void onFile(file); event.currentTarget.value = ""; }} /></label>;
}

export function DataView(props: DataViewProps) {
  const [chatGptConversations, setChatGptConversations] = useState<ImportedConversation[] | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [prepareError, setPrepareError] = useState("");
  const prepareChatGptImport = async (file: File) => {
    setPreparing(true);
    setPrepareError("");
    try {
      setChatGptConversations(await new ChatGptExportAdapter().parse(file));
    } catch (error) {
      console.error("[SAIVerse Lite][import] ChatGPT export preparation failed", error);
      setPrepareError(`ChatGPT の会話を読み込めませんでした: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setPreparing(false);
    }
  };
  const busy = props.busy || preparing;
  return (
    <section className="view content-view" aria-labelledby="data-title">
      <header className="view-header"><div><span className="eyebrow">PORTABILITY</span><h1 id="data-title">引っ越し</h1><p>関係をこの端末に閉じ込めず、いつでも持ち出せるようにします。</p></div></header>
      {(props.notice || prepareError) && <div className="notice" role="status">{prepareError || props.notice}</div>}
      <div className="data-grid">
        <article className="panel data-card"><span className="card-icon" aria-hidden="true"><Globe size={20} strokeWidth={1.8} /></span><h2>SAIVerse 本体へ</h2><p>{props.persona.name}の定義と、会話・記憶を本体互換形式で分けて書き出します。</p><div className="button-stack"><button className="button" onClick={props.onExportPersona} disabled={busy}>ペルソナ定義を保存</button><button className="button secondary" onClick={() => void props.onExportMemory()} disabled={busy}>会話+記憶を保存</button></div></article>
        <article className="panel data-card"><span className="card-icon" aria-hidden="true"><Smartphone size={20} strokeWidth={1.8} /></span><h2>端末を移る</h2><p>全ペルソナ・全履歴・設定を一つにまとめます。APIキーだけは含みません。</p><div className="button-stack"><button className="button" onClick={() => void props.onExportBackup()} disabled={busy}>フルバックアップ</button><FileAction label="バックアップを復元" accept="application/json,.json" disabled={busy} onFile={props.onImportBackup} /></div></article>
        <article className="panel data-card"><span className="card-icon" aria-hidden="true"><Download size={20} strokeWidth={1.8} /></span><h2>本体形式から戻す</h2><p>`saiverse_saimemory_v1` の会話と記憶を、選択中のパートナーへ取り込みます。</p><FileAction label="本体形式を読み込む" accept="application/json,.json" disabled={busy} onFile={props.onImportNative} /></article>
        <article className="panel data-card"><span className="card-icon" aria-hidden="true"><Import size={20} strokeWidth={1.8} /></span><h2>これまでの会話を連れてくる</h2><p>ChatGPT / Claude の公式エクスポート（JSON / ZIP、zip のままで OK）に対応。ChatGPT は取り込む会話とパートナーを選べます。Claude は本人が持っていた記憶（memories.json）も一緒に連れてきます。</p><div className="button-stack"><FileAction label={preparing ? "会話を確認中…" : "ChatGPT から"} accept="application/json,.json,application/zip,.zip" disabled={busy} onFile={prepareChatGptImport} /><FileAction label="Claude から" accept="application/json,.json,application/zip,.zip" disabled={busy} onFile={props.onImportClaude} /></div></article>
      </div>
      {chatGptConversations && <OfficialImportDialog conversations={chatGptConversations} personas={props.personas} providers={props.providers} defaultPersonaId={props.persona.id} busy={props.busy} onConfirm={props.onImportChatGpt} onClose={() => setChatGptConversations(null)} />}
    </section>
  );
}
