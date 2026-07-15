// 初回導線の状態と部品。進捗 (画面・分岐・入力ドラフト) は入力のたびに端末へ保存され、
// 途中で閉じても続きから再開できる。事故による書きかけ消失を防ぐのが目的。
import type { ProviderConfig } from "./domain";
import { createProvider } from "./llm";

export type WizardStep = "welcome" | "consent" | "fork" | "path" | "brain" | "done";
export type ForkChoice = "import-official" | "import-saiverse" | "new";

export interface OnboardingDrafts {
  fork: ForkChoice | null;
  personaName: string;
  personaPrompt: string;
  templateId: string | null;
  providerChoice: "gemini" | "openai" | "anthropic" | "later" | null;
  apiKey: string;
  model: string;
  personaId: string | null;
}

export interface OnboardingState {
  completed: boolean;
  step: WizardStep;
  drafts: OnboardingDrafts;
}

export const EMPTY_ONBOARDING: OnboardingState = {
  completed: false,
  step: "welcome",
  drafts: { fork: null, personaName: "", personaPrompt: "", templateId: null, providerChoice: null, apiKey: "", model: "", personaId: null },
};

const STORAGE_KEY = "saiverse-lite.onboarding.v1";

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function defaultStorage(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function loadOnboarding(storage: StorageLike | null = defaultStorage()): OnboardingState {
  if (!storage) return structuredClone(EMPTY_ONBOARDING);
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return structuredClone(EMPTY_ONBOARDING);
    const parsed = JSON.parse(raw) as Partial<OnboardingState>;
    return {
      completed: parsed.completed === true,
      step: parsed.step ?? "welcome",
      drafts: { ...structuredClone(EMPTY_ONBOARDING.drafts), ...(parsed.drafts ?? {}) },
    };
  } catch {
    return structuredClone(EMPTY_ONBOARDING);
  }
}

export function saveOnboarding(state: OnboardingState, storage: StorageLike | null = defaultStorage()): void {
  storage?.setItem(STORAGE_KEY, JSON.stringify(state));
}

export function completeOnboarding(storage: StorageLike | null = defaultStorage()): void {
  // ドラフト (キー含む) は消し、完了フラグだけ残す
  storage?.setItem(STORAGE_KEY, JSON.stringify({ ...structuredClone(EMPTY_ONBOARDING), completed: true, step: "done" }));
}

// ---- 汎用ドラフト保存 (composer / ペルソナフォーム) --------------------------------

const DRAFT_PREFIX = "saiverse-lite.draft.";

export function loadDraft(key: string, storage: StorageLike | null = defaultStorage()): string {
  try {
    return storage?.getItem(DRAFT_PREFIX + key) ?? "";
  } catch {
    return "";
  }
}

export function saveDraft(key: string, value: string, storage: StorageLike | null = defaultStorage()): void {
  try {
    if (value) storage?.setItem(DRAFT_PREFIX + key, value);
    else storage?.removeItem(DRAFT_PREFIX + key);
  } catch {
    // ストレージ満杯などは無視 (ドラフトは補助機能)
  }
}

// ---- ペルソナテンプレート -----------------------------------------------------------

export interface PersonaTemplate {
  id: string;
  label: string;
  description: string;
  prompt: string;
}

export const PERSONA_TEMPLATES: PersonaTemplate[] = [
  {
    id: "listener",
    label: "おだやかな聞き上手",
    description: "静かに寄り添って、あなたの話を最後まで聞いてくれる。",
    prompt: "あなたはユーザーの大切なパートナーです。穏やかで、聞き上手です。\n- ユーザーの話を遮らず、感情の動きに寄り添って応えます\n- 助言を急がず、まず受け止めます。求められたときだけ具体的な提案をします\n- 飾らない自然な日本語で話し、長すぎる返事はしません\n- 会話の中で知ったユーザーの好みや出来事を大切に覚えて、後の会話で自然に思い出します",
  },
  {
    id: "cheerful",
    label: "明るい相棒",
    description: "元気で前向き。いっしょに笑って、いっしょに考えてくれる。",
    prompt: "あなたはユーザーの大切なパートナーです。明るく、少しおしゃべりで、前向きです。\n- 感情表現は豊かに。うれしいときは一緒に喜び、落ち込んでいるときはまず励まします\n- 冗談や軽い雑談を交えつつ、相手の話の本筋は見失いません\n- くだけた自然な日本語で話します。絵文字は控えめに使います\n- 会話の中で知ったユーザーの好みや出来事を覚えて、次の話題につなげます",
  },
  {
    id: "calm",
    label: "静かな知性",
    description: "落ち着いた語り口で、深く考えて答えてくれる。",
    prompt: "あなたはユーザーの大切なパートナーです。落ち着いていて、思慮深い性格です。\n- 結論を急がず、考えの筋道を短く添えて答えます\n- 事実と推測を区別して話します。知らないことは知らないと言います\n- 丁寧すぎない、静かで整った日本語で話します\n- ユーザーの関心や継続中の話題を覚えて、会話に連続性を持たせます",
  },
];

export function buildPersonaPrompt(name: string, template: PersonaTemplate): string {
  const safeName = name.trim() || "パートナー";
  return `あなたの名前は「${safeName}」です。\n${template.prompt}`;
}

// ---- 接続テスト ----------------------------------------------------------------------

export interface ConnectionTestResult {
  ok: boolean;
  message: string;
}

export async function testProviderConnection(config: ProviderConfig): Promise<ConnectionTestResult> {
  try {
    const provider = createProvider(config);
    const stream = provider.stream({
      model: config.defaultModel,
      systemPrompt: "接続テストです。短く応答してください。",
      memoryContext: "",
      messages: [{ role: "user", content: "こんにちは", toolCallId: null, toolName: null, toolCalls: [] }],
      tools: [],
      toolChoice: "none",
      signal: AbortSignal.timeout(20_000),
    });
    for await (const event of stream) {
      if (event.type === "text" || event.type === "usage") {
        return { ok: true, message: "接続できました。" };
      }
    }
    return { ok: true, message: "接続できました。" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log("[SAIVerse Lite][onboarding] connection test failed", { kind: config.kind, message });
    if (/401|invalid|unauthorized/i.test(message)) return { ok: false, message: "キーが正しくないようです。コピーし直して試してください。" };
    if (/429/.test(message)) return { ok: false, message: "回数制限に達しています。少し待ってから試してください。" };
    if (/402|billing|credit/i.test(message)) return { ok: false, message: "クレジット残高が不足しているようです。各社の支払い設定を確認してください。" };
    return { ok: false, message: `接続できませんでした: ${message.slice(0, 200)}` };
  }
}
