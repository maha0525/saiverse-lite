// 法務文書 (プライバシーポリシー / 利用規約・免責)。
// 内容を変更したら LEGAL_VERSION を上げること — アプリが再同意を求める。
// ※この文面は素案であり、公開前に運営者 (まはー) のレビューを前提とする。

export const LEGAL_VERSION = "2026-07-16";

export interface LegalSection {
  heading: string;
  body: string;
}

export interface LegalDocument {
  title: string;
  version: string;
  sections: LegalSection[];
}

export const PRIVACY_POLICY: LegalDocument = {
  title: "プライバシーポリシー・外部送信について",
  version: LEGAL_VERSION,
  sections: [
    {
      heading: "基本方針",
      body: "SAIVerse Lite は、会話・記憶・ペルソナ定義・API キーをすべてお使いの端末内 (ブラウザの IndexedDB) に保存します。これらのデータが運営者のサーバーに送信・保存されることはありません。運営者はあなたの会話内容を見ることができません。",
    },
    {
      heading: "外部への送信 (1) LLM 事業者",
      body: "メッセージを送信すると、あなたが設定した LLM 事業者 (OpenAI / Anthropic / Google など) の API へ、API キーと会話内容 (システムプロンプト・注入される記憶を含む) が端末から直接送信されます。利用目的は応答の生成です。送信されたデータの取り扱いは各事業者のプライバシーポリシー・利用規約に従います。どの事業者に送るかは、あなたのプロバイダ設定だけが決めます。",
    },
    {
      heading: "外部への送信 (2) サイト配信",
      body: "本アプリは Cloudflare, Inc. のネットワークから配信されています。ウェブ配信の性質上、アクセス時に IP アドレスや HTTP リクエスト情報が Cloudflare に到達します。利用目的はコンテンツ配信とセキュリティ確保です。",
    },
    {
      heading: "運営者が収集しないもの",
      body: "本アプリには現在、広告・アクセス解析・トラッキングの仕組みを組み込んでいません。会話内容・API キー・記憶が運営者に届く経路はありません。ただし上記のとおり、配信事業者への技術的な情報の到達と、LLM 事業者へのあなた自身による送信は存在します。",
    },
    {
      heading: "今後の変更",
      body: "アクセス解析やエラー収集などの仕組みを導入する場合は、本ポリシーを改訂し、アプリ内で改めて確認をお願いします。",
    },
    {
      heading: "運営者",
      body: "本アプリは、個人開発者 まはー (GitHub: maha0525) が個人として開発・運営しています。法人組織ではありません。",
    },
    {
      heading: "お問い合わせ",
      body: "本ポリシーに関するご質問は contact@saiverse.net までお寄せください。アプリの不具合報告は https://github.com/maha0525/saiverse-lite/issues が確実です。",
    },
  ],
};

export const TERMS_OF_USE: LegalDocument = {
  title: "利用規約・免責事項",
  version: LEGAL_VERSION,
  sections: [
    {
      heading: "BYOK (自分のキーを使う) 方式について",
      body: "本アプリは、利用者自身が LLM 事業者と契約して取得した API キーを使う方式 (BYOK) です。API の利用料金は、利用者と各事業者との契約に基づいて利用者が負担します。運営者は料金の発生・金額について関与せず、責任を負いません。",
    },
    {
      heading: "AI の応答について",
      body: "AI の応答は誤りを含むことがあります。運営者は応答の正確性・有用性・特定目的への適合性を保証しません。医療・法律・金銭などの重要な判断には利用しないでください。",
    },
    {
      heading: "データとバックアップ",
      body: "データはすべて端末内に保存されます。端末の故障・ブラウザデータの消去・アプリの削除などによりデータが失われることがあります。バックアップ (引っ越し画面から作成できます) は利用者の責任で行ってください。",
    },
    {
      heading: "禁止事項",
      body: "法令に違反する利用、および接続先の各 LLM 事業者の利用規約に違反する利用を禁止します。",
    },
    {
      heading: "無保証・免責",
      body: "本アプリは GNU Affero General Public License v3.0 (AGPL v3) に基づき「現状のまま」提供され、明示・黙示を問わずいかなる保証も行いません (AGPL v3 第15条・第16条)。法令が許容する最大の範囲で、運営者は本アプリの利用または利用不能から生じる損害について責任を負いません。",
    },
    {
      heading: "ソースコードとライセンス",
      body: "本アプリのソースコードは AGPL v3 の下で https://github.com/maha0525/saiverse-lite にて公開されています。ライセンス全文: https://www.gnu.org/licenses/agpl-3.0.html （日本語の参考訳も各所にあります）。設定画面の「このアプリについて」から、動作中のバージョンに対応するソースコードとサードパーティライセンス一覧を確認できます。",
    },
    {
      heading: "運営者・お問い合わせ",
      body: "本アプリは、個人開発者 まはー (GitHub: maha0525) が個人として開発・運営しています。法人組織ではありません。お問い合わせ: contact@saiverse.net / 不具合報告: https://github.com/maha0525/saiverse-lite/issues",
    },
    {
      heading: "規約の変更",
      body: "本規約を変更する場合は、アプリ内で告知し、改めて確認をお願いします。",
    },
  ],
};
