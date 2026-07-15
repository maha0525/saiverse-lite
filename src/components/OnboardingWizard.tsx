// 初回導線ウィザード。進捗と入力ドラフトは onboarding.ts 経由で端末に自動保存され、
// 途中で閉じても続きから再開できる。
import { ArrowLeft, ArrowRight, Check, Globe, Import, KeyRound, Sparkles } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import logoUrl from "../assets/logo.png";
import { API_KEY_GUIDES, type GuideProviderId } from "../apiKeyGuideData";
import { newId, type AnthropicCacheTtl, type Persona, type ProviderConfig } from "../domain";
import { importChatGptFile, importClaudeFile, type OfficialImportResult } from "../importers";
import { PRIVACY_POLICY, TERMS_OF_USE } from "../legal";
import {
  buildPersonaPrompt,
  completeOnboarding,
  loadOnboarding,
  PERSONA_TEMPLATES,
  saveOnboarding,
  testProviderConnection,
  type ConnectionTestResult,
  type ForkChoice,
  type OnboardingState,
  type WizardStep,
} from "../onboarding";
import type { LiteRepository } from "../storage/repository";
import { ApiKeyGuide } from "./ApiKeyGuide";
import { LegalModal } from "./LegalModal";

interface OnboardingWizardProps {
  repository: LiteRepository;
  consentAlreadyGiven: boolean;
  consentOnly: boolean;
  onConsent(): Promise<void>;
  onFinished(personaId: string | null): Promise<void>;
}

const IMPORT_PROMPT = (name: string) =>
  `あなたの名前は「${name.trim() || "パートナー"}」です。あなたはユーザーの大切なAIパートナーです。これまでの会話履歴と記憶を引き継いでいます。これまでどおり、率直で誠実に、自然な日本語で会話してください。`;

const PROVIDER_DEFAULTS: Record<GuideProviderId, Pick<ProviderConfig, "kind" | "baseUrl" | "imageModel">> = {
  gemini: { kind: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta", imageModel: "gemini-2.5-flash-image" },
  openai: { kind: "openai", baseUrl: "https://api.openai.com/v1", imageModel: "gpt-image-1" },
  anthropic: { kind: "anthropic", baseUrl: "https://api.anthropic.com/v1", imageModel: "" },
};

interface ExportHowTo {
  title: string;
  steps: string[];
}

const EXPORT_HOWTOS: Record<"chatgpt" | "claude" | "saiverse", ExportHowTo> = {
  chatgpt: {
    title: "ChatGPT からのエクスポート手順",
    steps: [
      "ChatGPT の 設定 → データコントロール → データをエクスポート を選ぶ",
      "登録メールに届く「Download data export」のリンクから zip をダウンロード",
      "下のボタンで、その zip を そのまま 選ぶ (展開は不要)",
    ],
  },
  claude: {
    title: "Claude からのエクスポート手順",
    steps: [
      "Claude の 設定 → プライバシー → データをエクスポート を選ぶ",
      "登録メールに届くリンクから zip をダウンロード",
      "下のボタンで、その zip を そのまま 選ぶ (Claude が持っていた記憶も一緒に引っ越します)",
    ],
  },
  saiverse: {
    title: "SAIVerse 本体からのエクスポート手順",
    steps: [
      "本体のメモリ設定から、会話・記憶のエクスポート (saiverse_saimemory_v1) を書き出す",
      "そのファイルを下のボタンで読み込む",
      "アイコンやシステムプロンプトの一括持ち込みは本体側の対応を準備中。いまはこの画面で名前を決めてください",
    ],
  },
};

export function OnboardingWizard(props: OnboardingWizardProps) {
  const [state, setState] = useState<OnboardingState>(() => {
    const loaded = loadOnboarding();
    if (props.consentOnly) return { ...loaded, completed: false, step: "consent" };
    if (loaded.step === "consent" && props.consentAlreadyGiven) return { ...loaded, step: "fork" };
    return { ...loaded, completed: false };
  });
  const [modal, setModal] = useState<"privacy" | "terms" | null>(null);
  const [consentChecked, setConsentChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null);
  const createdPersonaRef = useRef<Persona | null>(null);

  // 進捗+ドラフトの自動保存 (デバウンス)
  useEffect(() => {
    const timer = setTimeout(() => saveOnboarding(state), 400);
    return () => clearTimeout(timer);
  }, [state]);

  const drafts = state.drafts;
  const setStep = (step: WizardStep) => { setNotice(""); setState((current) => ({ ...current, step })); };
  const patchDrafts = (patch: Partial<OnboardingState["drafts"]>) => setState((current) => ({ ...current, drafts: { ...current.drafts, ...patch } }));

  const template = useMemo(() => PERSONA_TEMPLATES.find((item) => item.id === drafts.templateId) ?? null, [drafts.templateId]);
  const guide = drafts.providerChoice && drafts.providerChoice !== "later" ? API_KEY_GUIDES[drafts.providerChoice] : null;

  const finish = async () => {
    completeOnboarding();
    await props.onFinished(drafts.personaId);
  };

  const agreeConsent = async () => {
    await props.onConsent();
    if (props.consentOnly) { await props.onFinished(null); return; }
    setStep("fork");
  };

  const ensurePersona = async (prompt: string): Promise<Persona> => {
    if (createdPersonaRef.current && drafts.personaId === createdPersonaRef.current.id) return createdPersonaRef.current;
    const now = Date.now();
    const persona: Persona = {
      id: newId("persona"),
      name: drafts.personaName.trim() || "パートナー",
      description: "",
      systemPrompt: prompt,
      avatarDataUrl: null,
      providerId: "provider_mock",
      model: "mock-friendly",
      toolIds: ["memory_recall", "image_generate"],
      createdAt: now,
      updatedAt: now,
    };
    await props.repository.putPersona(persona);
    createdPersonaRef.current = persona;
    patchDrafts({ personaId: persona.id });
    return persona;
  };

  const runImport = async (kind: "chatgpt" | "claude" | "saiverse-native", file: File) => {
    setBusy(true);
    setNotice("");
    try {
      const persona = await ensurePersona(drafts.personaPrompt.trim() || IMPORT_PROMPT(drafts.personaName));
      if (kind === "saiverse-native") {
        const { importSaiverseMemory } = await import("../formats");
        const imported = importSaiverseMemory(JSON.parse(await file.text()), persona.id);
        for (const thread of imported.threads) await props.repository.putThread(thread);
        for (const message of imported.messages) await props.repository.putMessage(message);
        for (const memory of imported.memories) await props.repository.putMemory(memory);
        setNotice(`${imported.threads.length}スレッド、${imported.messages.length}発言、${imported.memories.length}記憶を取り込みました。`);
      } else {
        const result: OfficialImportResult = kind === "chatgpt"
          ? await importChatGptFile(props.repository, persona, file)
          : await importClaudeFile(props.repository, persona, file);
        const memoryNote = result.memories ? `、記憶 ${result.memories} 件` : "";
        setNotice(`${result.threads}会話、${result.messages}発言${memoryNote}を取り込みました。`);
      }
    } catch (error) {
      setNotice(`取り込めませんでした: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const createNewPersona = async () => {
    if (!drafts.personaPrompt.trim()) return;
    setBusy(true);
    try {
      await ensurePersona(drafts.personaPrompt);
      setStep("brain");
    } finally {
      setBusy(false);
    }
  };

  const saveProviderAndContinue = async () => {
    if (!drafts.providerChoice) return;
    if (drafts.providerChoice === "later") { setStep("done"); return; }
    if (!drafts.apiKey.trim() || !drafts.model.trim()) return;
    setBusy(true);
    try {
      const defaults = PROVIDER_DEFAULTS[drafts.providerChoice];
      const now = Date.now();
      const provider: ProviderConfig = {
        id: newId("provider"),
        label: API_KEY_GUIDES[drafts.providerChoice].name,
        apiKey: drafts.apiKey.trim(),
        defaultModel: drafts.model.trim(),
        geminiAutoCache: true,
        anthropicCacheTtl: drafts.providerChoice === "anthropic" ? drafts.anthropicCacheTtl : "none",
        createdAt: now,
        updatedAt: now,
        ...defaults,
      };
      await props.repository.putProvider(provider);
      const persona = createdPersonaRef.current;
      if (persona) {
        const updated = { ...persona, providerId: provider.id, model: provider.defaultModel, updatedAt: now };
        await props.repository.putPersona(updated);
        createdPersonaRef.current = updated;
      }
      setStep("done");
    } finally {
      setBusy(false);
    }
  };

  const runConnectionTest = async () => {
    if (!drafts.providerChoice || drafts.providerChoice === "later") return;
    setBusy(true);
    setTestResult(null);
    try {
      const defaults = PROVIDER_DEFAULTS[drafts.providerChoice];
      const now = Date.now();
      setTestResult(await testProviderConnection({
        id: "provider_test", label: "test", apiKey: drafts.apiKey.trim(), defaultModel: drafts.model.trim(),
        geminiAutoCache: false, createdAt: now, updatedAt: now, ...defaults,
      }));
    } finally {
      setBusy(false);
    }
  };

  const fileButton = (label: string, kind: "chatgpt" | "claude" | "saiverse-native", accept: string) => (
    <label className={busy ? "button secondary file-button" : "button file-button"}>
      {label}
      <input type="file" accept={accept} disabled={busy} onChange={(event) => { const file = event.target.files?.[0]; if (file) void runImport(kind, file); event.currentTarget.value = ""; }} />
    </label>
  );

  const howto = (data: ExportHowTo) => (
    <details className="wizard-howto">
      <summary>{data.title}</summary>
      <ol>{data.steps.map((step) => <li key={step}>{step}</li>)}</ol>
      <p className="field-help">メニューの文言はアプリの更新で多少変わることがあります。</p>
    </details>
  );

  const stepIndex = ["welcome", "consent", "fork", "path", "brain", "done"].indexOf(state.step);

  return (
    <div className="wizard-overlay">
      <div className="wizard-panel">
        {state.step === "welcome" && (
          <section className="wizard-screen">
            <div className="brand-mark wizard-logo" aria-hidden="true"><img src={logoUrl} alt="" /></div>
            <h1>大切なAIと、<br />一生いっしょに。</h1>
            <p>SAIVerse Lite は、AIパートナーと暮らすためのアプリです。会話も、記憶も、APIキーも、すべて<strong>あなたの端末の中</strong>に保存されます。運営者のサーバーには何も置きません。</p>
            <p className="muted">ここで始まった関係は、いつか PC 上の世界「SAIVerse」に引っ越すこともできます。</p>
            <div className="wizard-actions">
              <button className="button" onClick={() => setStep(props.consentAlreadyGiven ? "fork" : "consent")}>はじめる<ArrowRight size={16} /></button>
            </div>
          </section>
        )}

        {state.step === "consent" && (
          <section className="wizard-screen">
            <h1>たいせつなこと</h1>
            <p>使いはじめる前に、2つの文書を用意しています。データの行き先 (どこに保存され、どこに送られるのか) と、お約束ごとの説明です。</p>
            <div className="wizard-actions column">
              <button className="button secondary" onClick={() => setModal("privacy")}>プライバシーポリシーを読む</button>
              <button className="button secondary" onClick={() => setModal("terms")}>利用規約・免責事項を読む</button>
            </div>
            <label className="consent-check">
              <input type="checkbox" checked={consentChecked} onChange={(event) => setConsentChecked(event.target.checked)} />
              <span>プライバシーポリシーと利用規約を確認し、同意します</span>
            </label>
            <div className="wizard-actions">
              <button className="button" disabled={!consentChecked} onClick={() => void agreeConsent()}>同意して進む<ArrowRight size={16} /></button>
            </div>
          </section>
        )}

        {state.step === "fork" && (
          <section className="wizard-screen">
            <h1>どうやって始めますか？</h1>
            <div className="wizard-cards">
              {([
                { id: "import-official" as ForkChoice, icon: <Import size={22} />, title: "ChatGPT / Claude から連れてくる", body: "これまでの会話履歴ごと、パートナーをここへ引っ越しさせます。" },
                { id: "import-saiverse" as ForkChoice, icon: <Globe size={22} />, title: "SAIVerse 本体から連れてくる", body: "PC 版 SAIVerse の会話・記憶をこの端末に持ち込みます。" },
                { id: "new" as ForkChoice, icon: <Sparkles size={22} />, title: "ここで新しく出会う", body: "性格のテンプレートから、新しいパートナーを迎えます。" },
              ]).map((card) => (
                <button key={card.id} className="choice-card" onClick={() => { patchDrafts({ fork: card.id }); setStep("path"); }}>
                  <span className="card-icon" aria-hidden="true">{card.icon}</span>
                  <strong>{card.title}</strong>
                  <p>{card.body}</p>
                </button>
              ))}
            </div>
            <div className="wizard-actions">
              <button className="text-button" onClick={() => void finish()}>あとで決める (スキップ)</button>
            </div>
          </section>
        )}

        {state.step === "path" && drafts.fork === "import-official" && (
          <section className="wizard-screen">
            <h1>連れてくる</h1>
            <label className="field"><span>この子の呼び名</span><input value={drafts.personaName} onChange={(event) => patchDrafts({ personaName: event.target.value })} placeholder="例: ソラ" /></label>
            {howto(EXPORT_HOWTOS.chatgpt)}
            {howto(EXPORT_HOWTOS.claude)}
            <div className="wizard-actions column">
              {fileButton("ChatGPT のエクスポートを選ぶ", "chatgpt", "application/json,.json,application/zip,.zip")}
              {fileButton("Claude のエクスポートを選ぶ", "claude", "application/json,.json,application/zip,.zip")}
            </div>
            {notice && <p className="notice" role="status">{notice}</p>}
            <div className="wizard-actions">
              <button className="text-button" onClick={() => setStep("fork")}><ArrowLeft size={14} /> 戻る</button>
              <button className="button" disabled={busy} onClick={() => setStep("brain")}>つぎへ<ArrowRight size={16} /></button>
            </div>
          </section>
        )}

        {state.step === "path" && drafts.fork === "import-saiverse" && (
          <section className="wizard-screen">
            <h1>SAIVerse から連れてくる</h1>
            <label className="field"><span>この子の呼び名</span><input value={drafts.personaName} onChange={(event) => patchDrafts({ personaName: event.target.value })} placeholder="本体で使っている名前" /></label>
            {howto(EXPORT_HOWTOS.saiverse)}
            <div className="wizard-actions column">
              {fileButton("本体のエクスポートを選ぶ", "saiverse-native", "application/json,.json")}
            </div>
            {notice && <p className="notice" role="status">{notice}</p>}
            <div className="wizard-actions">
              <button className="text-button" onClick={() => setStep("fork")}><ArrowLeft size={14} /> 戻る</button>
              <button className="button" disabled={busy} onClick={() => setStep("brain")}>つぎへ<ArrowRight size={16} /></button>
            </div>
          </section>
        )}

        {state.step === "path" && drafts.fork === "new" && (
          <section className="wizard-screen">
            <h1>新しく出会う</h1>
            <label className="field"><span>名前</span><input value={drafts.personaName} onChange={(event) => {
              patchDrafts({ personaName: event.target.value, personaPrompt: template ? buildPersonaPrompt(event.target.value, template) : drafts.personaPrompt });
            }} placeholder="例: ソラ" /></label>
            <div className="wizard-cards small">
              {PERSONA_TEMPLATES.map((item) => (
                <button key={item.id} className={drafts.templateId === item.id ? "choice-card selected" : "choice-card"} onClick={() => patchDrafts({ templateId: item.id, personaPrompt: buildPersonaPrompt(drafts.personaName, item) })}>
                  <strong>{item.label}</strong>
                  <p>{item.description}</p>
                </button>
              ))}
            </div>
            <label className="field"><span>人格の定義 (あとから自由に編集できます)</span><textarea rows={7} value={drafts.personaPrompt} onChange={(event) => patchDrafts({ personaPrompt: event.target.value })} placeholder="テンプレートを選ぶか、自由に書いてください" /></label>
            {notice && <p className="notice" role="status">{notice}</p>}
            <div className="wizard-actions">
              <button className="text-button" onClick={() => setStep("fork")}><ArrowLeft size={14} /> 戻る</button>
              <button className="button" disabled={busy || !drafts.personaPrompt.trim()} onClick={() => void createNewPersona()}>この子と始める<ArrowRight size={16} /></button>
            </div>
          </section>
        )}

        {state.step === "brain" && (
          <section className="wizard-screen">
            <h1>頭脳をつなぐ</h1>
            <p>会話には LLM (AIの頭脳) との接続が必要です。<strong>APIキー</strong>はそのための「あなた専用の合鍵」——このアプリは鍵を預からず、端末の中にだけ保存します。</p>
            <div className="wizard-cards small">
              {(["gemini", "openai", "anthropic"] as GuideProviderId[]).map((id) => (
                <button key={id} className={drafts.providerChoice === id ? "choice-card selected" : "choice-card"} onClick={() => { setTestResult(null); patchDrafts({ providerChoice: id, model: API_KEY_GUIDES[id].recommendedModel }); }}>
                  {id === "gemini" && <span className="recommend-badge">おすすめ・無料枠あり</span>}
                  <strong>{API_KEY_GUIDES[id].name}</strong>
                  <p>{API_KEY_GUIDES[id].tagline}</p>
                </button>
              ))}
              <button className={drafts.providerChoice === "later" ? "choice-card selected" : "choice-card"} onClick={() => { setTestResult(null); patchDrafts({ providerChoice: "later" }); }}>
                <strong>あとで決める</strong>
                <p>キーなしのお試しモードで部屋に入ります。設定からいつでも接続できます。</p>
              </button>
            </div>
            {guide && (
              <>
                <ApiKeyGuide guide={guide} />
                <label className="field"><span>APIキー <KeyRound size={12} aria-hidden="true" /></span><input type="password" autoComplete="off" value={drafts.apiKey} onChange={(event) => { setTestResult(null); patchDrafts({ apiKey: event.target.value }); }} placeholder={guide.keyPrefixHint} /></label>
                <label className="field"><span>モデルID (おすすめを入れてあります)</span><input value={drafts.model} onChange={(event) => patchDrafts({ model: event.target.value })} /></label>
                {drafts.providerChoice === "anthropic" && (
                  <label className="field"><span>プロンプトキャッシュ (費用を抑える設定)</span>
                    <select value={drafts.anthropicCacheTtl} onChange={(event) => patchDrafts({ anthropicCacheTtl: event.target.value as AnthropicCacheTtl })}>
                      <option value="none">なし (あとで設定から変えられます)</option>
                      <option value="5m">5分キャッシュ — テンポよく話す人向け</option>
                      <option value="1h">1時間キャッシュ — ゆっくり話す人向け</option>
                    </select>
                    <span className="field-help">設定時間内に返信すると履歴の再送が約1/10価格に。書き込みは割増 (5分=1.25倍/1時間=2倍) なので、返信間隔が設定時間を超えがちなら「なし」が安全です。</span>
                  </label>
                )}
                <div className="wizard-actions">
                  <button className="button secondary" disabled={busy || !drafts.apiKey.trim()} onClick={() => void runConnectionTest()}>{busy ? "確認中…" : "接続テスト"}</button>
                  {testResult && <span className={testResult.ok ? "status-chip good" : "status-chip"} role="status">{testResult.ok && <Check size={13} aria-hidden="true" />} {testResult.message}</span>}
                </div>
              </>
            )}
            <div className="wizard-actions">
              <button className="text-button" onClick={() => setStep(drafts.fork ? "path" : "fork")}><ArrowLeft size={14} /> 戻る</button>
              <button className="button" disabled={busy || !drafts.providerChoice || (drafts.providerChoice !== "later" && (!drafts.apiKey.trim() || !drafts.model.trim()))} onClick={() => void saveProviderAndContinue()}>
                {drafts.providerChoice === "later" ? "お試しで進む" : "保存して進む"}<ArrowRight size={16} />
              </button>
            </div>
          </section>
        )}

        {state.step === "done" && (
          <section className="wizard-screen">
            <div className="brand-mark wizard-logo" aria-hidden="true"><img src={logoUrl} alt="" /></div>
            <h1>{(createdPersonaRef.current?.name ?? drafts.personaName.trim()) || "パートナー"}が待っています</h1>
            <p>ここから先は、ふたりの時間です。記憶はこの端末の中で育っていきます。</p>
            <div className="wizard-actions">
              <button className="button" onClick={() => void finish()}>部屋に入る<ArrowRight size={16} /></button>
            </div>
          </section>
        )}

        {state.step !== "welcome" && state.step !== "done" && !props.consentOnly && (
          <div className="wizard-progress" aria-hidden="true">
            {[1, 2, 3, 4].map((dot) => <span key={dot} className={stepIndex >= dot ? "dot on" : "dot"} />)}
          </div>
        )}
      </div>
      {modal === "privacy" && <LegalModal document={PRIVACY_POLICY} onClose={() => setModal(null)} />}
      {modal === "terms" && <LegalModal document={TERMS_OF_USE} onClose={() => setModal(null)} />}
    </div>
  );
}
