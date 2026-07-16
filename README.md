# SAIVerse Lite

SAIVerse Lite は、ペルソナと記憶を端末内に置いたまま各社 LLM API を直接利用する、
モバイル向けの軽量 PWA です。中間サーバーは持たず、API キー・会話・記憶は
IndexedDB に保存します。フルバックアップから API キーは必ず除外されます。

ライセンスは [GNU Affero General Public License v3.0](LICENSE) です。

## 開発

Node.js 22 以降と pnpm を使います。

```bash
pnpm install
pnpm dev
```

品質確認:

```bash
pnpm typecheck
pnpm test
pnpm build
```

`pnpm dev` が表示する URL をブラウザで開いてください。API キーとモデル名は
「設定」で端末ごとに登録します。最初から入っている Mock プロバイダなら API キー
なしで会話、記憶要約、ツール呼び出しを確認できます。

## v1 の実装範囲

- OpenAI、Anthropic、Gemini、OpenAI 互換 URL、Mock の BYOK プロバイダ
- Gemini explicit cache の create → generate → delete と、短い入力・作成失敗時の通常呼び出し
- 複数ペルソナ、固定 system prompt、ペルソナ単位の固定ツール登録
- ストリーミング会話、複数スレッド、メッセージ編集、回答再生成
- 履歴永続化、自動要約、記憶の閲覧・追加・編集・削除
- ChatGPT 公式エクスポートの JSON / ZIP インポート
- SAIVerse 本体互換の会話・記憶エクスポート、ペルソナエクスポート、フルバックアップと復元
- ネイティブ function calling 基盤、記憶想起・画像生成ツール
- 日本語 UI、ライト / ダークテーマ、manifest、service worker、インストール導線
- 初回導線ウィザード（3つの始めかた + API キー取得ガイド + 接続テスト。進捗と入力は端末に自動保存され、途中で閉じても再開できます）
- プライバシーポリシー・利用規約への同意記録、会話入力とフォームのドラフト自動保存
- 設定「このアプリについて」: 動作中の版に対応するソースコードリンク、AGPL v3 表示、サードパーティライセンス（`corepack pnpm licenses:gen` で再生成）

境界をまたぐ形式の正典は [FORMATS.md](FORMATS.md)、設計判断と残課題は
[HANDOFF.md](HANDOFF.md) にあります。

Gemma 4 E2B / E4B を PWA 上でオンデバイス実行する調査結果と実装案は、
[docs/gemma4_on_device.md](docs/gemma4_on_device.md) にあります（実装・実機検証は未着手）。

## 検証済み

2026-07-16 に次をローカル実行しました。

- TypeScript strict 型検査: 成功
- Vitest: 6 ファイル、20 テスト成功
- Vite production build: 成功
- production preview の HTTP smoke test: HTML、manifest、service worker がすべて 200
- メモリ実装と fake IndexedDB の共通ストレージ契約
- Lite バックアップ、および `saiverse_saimemory_v1` のラウンドトリップ
- ChatGPT active branch / hidden message のパーサ規則
- Mock 会話、自動要約、記憶想起ツール
- 通信モックによる OpenAI Responses API の推論状態を含む tool-call 連鎖、
  OpenAI 互換 Chat Completions、Anthropic 必須ヘッダと cache breakpoint、
  Gemini cache の作成・利用・削除

## 未検証

- 実 API キーを使った OpenAI / Anthropic / Gemini / OpenAI 互換 API との通信
- 実サービス上の CORS、レート制限、モデルごとの差異、画像生成結果
- 実データ量の ChatGPT ZIP インポート
- Claude 公式エクスポート（サンプル不在のため、推測実装をしていません）
- SAIVerse 本体へのペルソナ、および会話・記憶ファイルの end-to-end インポート
- モバイル実機でのインストール、オフライン再起動、永続ストレージ許可

## Cloudflare Workers へのデプロイ

本番Worker名は `saiverse-lite`、配信対象は Vite が生成する `dist/` です。
`app.saiverse.net` のCustom DomainはCloudflare側の既存Worker設定を使用します。

初回のみ、CloudflareアカウントをOAuth認証します。Windowsでは資格情報を
Credential Managerへ暗号化保存するため、`--use-keyring` を指定してください。

```powershell
corepack pnpm exec wrangler login --use-keyring
```

アップロードせず設定・テスト・ビルドを検証する場合:

```powershell
corepack pnpm deploy:dry-run
```

テストとproduction buildが成功した場合だけ本番へデプロイします:

```powershell
corepack pnpm deploy
```

API tokenを使う場合も値をリポジトリへ保存しないでください。CIでは
`CLOUDFLARE_ACCOUNT_ID` と `CLOUDFLARE_API_TOKEN` をsecretとして設定します。

## セキュリティ境界

キーをブラウザに保存して API を直接呼ぶこと自体が、このアプリの BYOK 設計です。
ホストした第三者サーバーへキーを預ける構成ではありませんが、端末・ブラウザプロファイル・
拡張機能を信頼する必要があります。会話内容は選んだ LLM 事業者へ送信されます。
