import { ExternalLink } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { newId, type AnthropicCacheTtl, type AppSettings, type ProviderConfig, type ProviderKind } from "../domain";
import { PRIVACY_POLICY, TERMS_OF_USE } from "../legal";
import { THIRD_PARTY_LICENSES } from "../thirdPartyLicenses";
import { LegalModal } from "./LegalModal";

const REPO_URL = "https://github.com/maha0525/saiverse-lite";

interface SettingsViewProps {
  providers: ProviderConfig[];
  settings: AppSettings;
  canInstall: boolean;
  onInstall(): Promise<void>;
  onSaveProvider(provider: ProviderConfig): Promise<void>;
  onDeleteProvider(id: string): Promise<void>;
  onSaveSettings(settings: AppSettings): Promise<void>;
  onRestartOnboarding(): void;
}

function newProvider(kind: ProviderKind): ProviderConfig {
  const now = Date.now();
  const defaults: Record<ProviderKind, Pick<ProviderConfig, "label" | "baseUrl" | "defaultModel" | "imageModel">> = {
    mock: { label: "モック（APIキー不要）", baseUrl: "mock://local", defaultModel: "mock-friendly", imageModel: "mock-image" },
    openai: { label: "OpenAI", baseUrl: "https://api.openai.com/v1", defaultModel: "", imageModel: "gpt-image-1" },
    anthropic: { label: "Anthropic", baseUrl: "https://api.anthropic.com/v1", defaultModel: "", imageModel: "" },
    gemini: { label: "Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta", defaultModel: "", imageModel: "gemini-2.5-flash-image" },
    "openai-compatible": { label: "OpenAI互換", baseUrl: "http://127.0.0.1:1234/v1", defaultModel: "", imageModel: "" },
  };
  return {
    id: newId("provider"),
    kind,
    ...defaults[kind],
    apiKey: "",
    geminiAutoCache: true,
    createdAt: now,
    updatedAt: now,
  };
}

export function SettingsView(props: SettingsViewProps) {
  const [modal, setModal] = useState<"privacy" | "terms" | "licenses" | null>(null);
  const [selectedId, setSelectedId] = useState(props.providers[0]?.id ?? "");
  const selected = props.providers.find((provider) => provider.id === selectedId);
  const [draft, setDraft] = useState<ProviderConfig>(() => selected ?? newProvider("openai"));
  const [localSettings, setLocalSettings] = useState(props.settings);
  useEffect(() => { if (selected) setDraft(structuredClone(selected)); }, [selected]);
  useEffect(() => setLocalSettings(props.settings), [props.settings]);

  const submitProvider = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft.label.trim() || !draft.defaultModel.trim()) return;
    await props.onSaveProvider({ ...draft, updatedAt: Date.now() });
    setSelectedId(draft.id);
  };
  const submitSettings = async (event: FormEvent) => {
    event.preventDefault();
    await props.onSaveSettings(localSettings);
  };
  return (
    <section className="view content-view" aria-labelledby="settings-title">
      <header className="view-header"><div><span className="eyebrow">SETTINGS</span><h1 id="settings-title">設定</h1><p>キーはこの端末の IndexedDB だけに保存され、バックアップには入りません。</p></div>{props.canInstall && <button className="button" onClick={() => void props.onInstall()}>ホーム画面に追加</button>}</header>
      <div className="settings-grid">
        <form className="panel form-panel" onSubmit={(event) => void submitProvider(event)}>
          <div className="form-heading"><h2>LLM プロバイダ</h2><span className="local-chip">BYOK</span></div>
          <div className="provider-tabs">
            {props.providers.map((provider) => <button type="button" key={provider.id} className={selectedId === provider.id ? "chip selected" : "chip"} onClick={() => setSelectedId(provider.id)}>{provider.label}</button>)}
          </div>
          <label className="field"><span>種類</span><select value={draft.kind} disabled={draft.id === "provider_mock"} onChange={(event) => setDraft(newProvider(event.target.value as ProviderKind))}>
            <option value="openai">OpenAI</option><option value="anthropic">Anthropic</option><option value="gemini">Gemini</option><option value="openai-compatible">OpenAI互換URL</option><option value="mock">モック</option>
          </select></label>
          <label className="field"><span>表示名</span><input value={draft.label} onChange={(event) => setDraft({ ...draft, label: event.target.value })} required /></label>
          <label className="field"><span>APIキー</span><input type="password" autoComplete="off" value={draft.apiKey} onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })} placeholder={draft.kind === "mock" ? "不要" : "端末内に保存"} disabled={draft.kind === "mock"} /></label>
          <label className="field"><span>Base URL</span><input value={draft.baseUrl} onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} required /></label>
          <div className="field-grid"><label className="field"><span>会話モデルID</span><input value={draft.defaultModel} onChange={(event) => setDraft({ ...draft, defaultModel: event.target.value })} required /></label><label className="field"><span>画像モデルID</span><input value={draft.imageModel} onChange={(event) => setDraft({ ...draft, imageModel: event.target.value })} /></label></div>
          {draft.kind === "gemini" && <label className="toggle"><input type="checkbox" checked={draft.geminiAutoCache} onChange={(event) => setDraft({ ...draft, geminiAutoCache: event.target.checked })} /><span><strong>Gemini 自動キャッシュ</strong><small>create → generate → delete。短い入力は通常コールへ戻します。</small></span></label>}
          {draft.kind === "anthropic" && <label className="field"><span>プロンプトキャッシュ</span><select value={draft.anthropicCacheTtl ?? "none"} onChange={(event) => setDraft({ ...draft, anthropicCacheTtl: event.target.value as AnthropicCacheTtl })}>
            <option value="none">なし (既定)</option>
            <option value="5m">5分キャッシュ — テンポよく話す人向け</option>
            <option value="1h">1時間キャッシュ — ゆっくり話す人向け</option>
          </select><span className="field-help">設定時間内に次の返信をすると、履歴の再送が約1/10価格になります。書き込みは割増 (5分=1.25倍/1時間=2倍) のため、返信間隔が設定時間を超えがちだと逆に割高です。</span></label>}
          <div className="form-actions"><button className="button" type="submit">プロバイダを保存</button><button className="button secondary" type="button" onClick={() => { const provider = newProvider("openai"); setDraft(provider); setSelectedId(provider.id); }}>新規追加</button>{draft.id !== "provider_mock" && props.providers.some((item) => item.id === draft.id) && <button className="text-button danger" type="button" onClick={() => void props.onDeleteProvider(draft.id)}>削除</button>}</div>
        </form>
        <form className="panel form-panel" onSubmit={(event) => void submitSettings(event)}>
          <div className="form-heading"><h2>アプリ</h2><span className={localSettings.storagePersisted ? "status-chip good" : "status-chip"}>{localSettings.storagePersisted ? "永続ストレージ許可済み" : "通常ストレージ"}</span></div>
          <label className="field"><span>テーマ</span><select value={localSettings.theme} onChange={(event) => setLocalSettings({ ...localSettings, theme: event.target.value as AppSettings["theme"] })}><option value="system">端末に合わせる</option><option value="light">ライト</option><option value="dark">ダーク</option></select></label>
          <label className="field"><span>自動要約までの発言数</span><input type="number" min={4} max={100} value={localSettings.summaryEveryMessages} onChange={(event) => setLocalSettings({ ...localSettings, summaryEveryMessages: Number(event.target.value) })} /></label>
          <label className="field"><span>会話へ入れる直近メッセージ数</span><input type="number" min={4} max={200} value={localSettings.recentContextMessages} onChange={(event) => setLocalSettings({ ...localSettings, recentContextMessages: Number(event.target.value) })} /></label>
          <p className="field-help">要約は固定されたシステムプロンプトの後、直近履歴の前に注入されます。ペルソナのツール定義は会話中に増減しません。</p>
          <button className="button" type="submit">アプリ設定を保存</button>
        </form>
        <div className="panel form-panel about-panel">
          <div className="form-heading"><h2>このアプリについて</h2><span className="local-chip">AGPL v3</span></div>
          <p className="field-help">SAIVerse Lite v{__APP_VERSION__} (ビルド <a href={`${REPO_URL}/tree/${__BUILD_COMMIT__}`} target="_blank" rel="noreferrer noopener">{__BUILD_COMMIT__}</a>)。本アプリは自由ソフトウェアであり、GNU Affero General Public License v3.0 の下で「現状のまま」無保証で提供されます。動作中のこの版に対応するソースコードは下のリンクから入手できます。</p>
          <div className="about-links">
            <a className="text-button" href={REPO_URL} target="_blank" rel="noreferrer noopener">ソースコード (GitHub) <ExternalLink size={13} aria-hidden="true" /></a>
            <a className="text-button" href={`${REPO_URL}/blob/main/LICENSE`} target="_blank" rel="noreferrer noopener">ライセンス全文 (AGPL v3) <ExternalLink size={13} aria-hidden="true" /></a>
            <button type="button" className="text-button" onClick={() => setModal("licenses")}>サードパーティライセンス</button>
            <button type="button" className="text-button" onClick={() => setModal("privacy")}>プライバシーポリシー</button>
            <button type="button" className="text-button" onClick={() => setModal("terms")}>利用規約・免責事項</button>
            <button type="button" className="text-button" onClick={props.onRestartOnboarding}>はじめかたガイドをもう一度</button>
          </div>
        </div>
      </div>
      {modal === "privacy" && <LegalModal document={PRIVACY_POLICY} onClose={() => setModal(null)} />}
      {modal === "terms" && <LegalModal document={TERMS_OF_USE} onClose={() => setModal(null)} />}
      {modal === "licenses" && <LegalModal document={THIRD_PARTY_LICENSES} onClose={() => setModal(null)} />}
    </section>
  );
}
