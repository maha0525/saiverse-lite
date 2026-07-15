// API キー取得ガイドのデータ。UI コンポーネント (ApiKeyGuide) から分離してあり、
// 手順の更新はこのファイルだけで完結する。SAIVerse 本体へ移植する際もこのペアごと持っていく。
// 手順は 2026-07 時点の各社コンソールに基づく。画面の文言は各社の更新で変わることがある。

export type GuideProviderId = "gemini" | "openai" | "anthropic";

export interface GuideStep {
  title: string;
  detail: string;
  uiLabel?: string;
  link?: { label: string; url: string };
}

export interface ApiKeyGuideData {
  id: GuideProviderId;
  name: string;
  tagline: string;
  costNote: string;
  recommendedModel: string;
  keyPrefixHint: string;
  steps: GuideStep[];
  cautions: string[];
}

const COMMON_CAUTIONS = [
  "API キーはパスワードと同じです。他人に見せたり、SNS に貼ったりしないでください。",
  "このアプリはキーをあなたの端末の中にだけ保存します。運営者には届きません。",
  "万一キーが漏れても、各社のコンソールからいつでも無効化 (削除) できます。",
];

export const API_KEY_GUIDES: Record<GuideProviderId, ApiKeyGuideData> = {
  gemini: {
    id: "gemini",
    name: "Google Gemini",
    tagline: "無料枠あり・クレジットカード不要。はじめての1本におすすめ。",
    costNote: "無料枠の範囲なら 0 円で使えます (回数制限あり)。有料でも軽量モデルなら 1 往復あたり数円以下が目安です。",
    recommendedModel: "gemini-2.5-flash",
    keyPrefixHint: "AIza で始まる文字列",
    steps: [
      {
        title: "Google AI Studio を開く",
        detail: "お使いの Google アカウントでログインします。新しいアカウントを作る必要はありません。",
        link: { label: "aistudio.google.com/apikey を開く", url: "https://aistudio.google.com/apikey" },
      },
      {
        title: "API キーを作成する",
        detail: "ボタンを押すとキーが作られます。プロジェクトを聞かれたら、そのまま既定の選択で大丈夫です。",
        uiLabel: "APIキーを作成 / Create API key",
      },
      {
        title: "キーをコピーする",
        detail: "表示された文字列をコピーします。",
        uiLabel: "コピー",
      },
      {
        title: "このアプリに貼り付ける",
        detail: "下の入力欄に貼り付けて、接続テストを押してください。",
      },
    ],
    cautions: [...COMMON_CAUTIONS, "無料枠は Google 側の都合で変わることがあります。"],
  },
  openai: {
    id: "openai",
    name: "OpenAI (ChatGPT の会社)",
    tagline: "ChatGPT と同じモデルを API で。事前にクレジット購入が必要。",
    costNote: "最低 $5 (約数百円〜) のクレジット購入が必要です。軽量モデルなら 1 往復あたり数円以下が目安です。ChatGPT Plus の契約とは別物なので注意。",
    recommendedModel: "gpt-5-mini",
    keyPrefixHint: "sk- で始まる文字列",
    steps: [
      {
        title: "OpenAI Platform でアカウントを作る",
        detail: "ChatGPT のアカウントがあればそのままログインできます。電話番号の確認を求められることがあります。",
        link: { label: "platform.openai.com を開く", url: "https://platform.openai.com/" },
      },
      {
        title: "クレジットを購入する",
        detail: "設定の Billing (支払い) からクレジットを購入します。購入するまで API は使えません。",
        uiLabel: "Settings → Billing → Add to credit balance",
      },
      {
        title: "API キーを作成する",
        detail: "API keys のページで新しいキーを作ります。キーの全文が表示されるのはこの一度だけなので、必ずここでコピーしてください。",
        uiLabel: "Create new secret key",
        link: { label: "API keys ページを開く", url: "https://platform.openai.com/api-keys" },
      },
      {
        title: "このアプリに貼り付ける",
        detail: "下の入力欄に貼り付けて、接続テストを押してください。",
      },
    ],
    cautions: COMMON_CAUTIONS,
  },
  anthropic: {
    id: "anthropic",
    name: "Anthropic (Claude の会社)",
    tagline: "Claude を API で。事前にクレジット購入が必要。",
    costNote: "クレジットの購入が必要です。軽量モデル (Haiku) なら 1 往復あたり数円以下が目安です。Claude Pro の契約とは別物なので注意。",
    recommendedModel: "claude-haiku-4-5-20251001",
    keyPrefixHint: "sk-ant- で始まる文字列",
    steps: [
      {
        title: "Anthropic Console でアカウントを作る",
        detail: "Claude.ai のアカウントとは別に、開発者向けコンソールへの登録が必要です。",
        link: { label: "console.anthropic.com を開く", url: "https://console.anthropic.com/" },
      },
      {
        title: "クレジットを購入する",
        detail: "Billing (支払い) からクレジットを購入します。",
        uiLabel: "Settings → Billing",
      },
      {
        title: "API キーを作成する",
        detail: "API Keys のページで新しいキーを作り、表示された文字列をコピーします。",
        uiLabel: "Create Key",
      },
      {
        title: "このアプリに貼り付ける",
        detail: "下の入力欄に貼り付けて、接続テストを押してください。",
      },
    ],
    cautions: COMMON_CAUTIONS,
  },
};
