# Gemma 4 E2B / E4B オンデバイス対応 調査・実装方針

調査日: 2026-07-16
対象: SAIVerse Lite（PWA）
基準ランタイム: `@litert-lm/core@0.14.0`

## 1. 結論

SAIVerse Lite の現在の PWA 構成のまま、Gemma 4 E2B / E4B をスマートフォン上で直接動かせる可能性は高い。

Google AI Edge Gallery はオンデバイス推論の完成例・検証用アプリであり、SAIVerse Lite がインストール済み Edge Gallery に推論を依頼するための公開 API は、公開資料と公開ソースからは確認できなかった。Edge Gallery を外部エンジンとして呼ぶ設計にはしない。

代わりに、Edge Gallery と同じ基盤である LiteRT-LM を SAIVerse Lite 自身へ組み込む。LiteRT-LM にはブラウザ向け JavaScript / TypeScript API があり、WebGPU で次の Web 専用モデルを実行できる。

- `gemma-4-E2B-it-web.litertlm`（約 2.01 GB）
- `gemma-4-E4B-it-web.litertlm`（約 2.97 GB）

ブラウザ API はストリーミング、system role、会話履歴、キャンセルに対応する。LiteRT-LM v0.14.0 では JavaScript 版にも function calling が追加された。SAIVerse Lite の固定 system prompt、固定ツール定義、`memory_recall` / `image_generate` のツールループへ接続できる構造である。

ただし Web API はまだ Early Preview である。実機上の速度、メモリ不足、数 GB の端末保存、ツール呼び出し精度は未検証であり、現時点で「SAIVerse Lite 上で動作確認済み」とは扱わない。

## 2. Edge Gallery との関係

```text
Google AI Edge Gallery
  └─ LiteRT-LM（ネイティブ Android / iOS の実装例）

SAIVerse Lite PWA
  └─ @litert-lm/core（LiteRT-LM.js / WebGPU）
       └─ Gemma 4 の Web 専用 .litertlm
```

両者は同じ推論基盤を使うが、アプリ間でモデルや推論セッションを共有しない。Edge Gallery でモデルをダウンロード済みでも、SAIVerse Lite は自身の origin 用ストレージへモデルを別途保存する必要がある。

Edge Gallery のネイティブ実装は、将来 Capacitor 化してネイティブ LiteRT-LM を使う場合の参考になる。まず PWA の Web API を採用し、性能または安定性が不足した場合だけネイティブ化を検討する。

## 3. 確認できた機能

| 項目 | 確認結果 |
|---|---|
| Web 実行 | LiteRT-LM JavaScript API が WebGPU によりブラウザ内で実行する |
| 対応モデル | 現在は E2B / E4B の `-web.litertlm` に限定 |
| ストリーミング | `sendMessageStreaming()` が `ReadableStream` を返す |
| system prompt | `preface.messages` に `role: "system"` を指定可能 |
| モデル入力 | URL、`ReadableStream`、`Blob` を `Engine.create()` に渡せる |
| ツール | v0.14.0 で LiteRT-LM.js の full tool calling support が追加された |
| マルチモーダル | Gemma 4 自体は対応するが、Web API は現在 text-in / text-out のみ |
| Web API 成熟度 | Early Preview |
| ネイティブ API | Kotlin は Stable、Swift は Early Preview |

`@litert-lm/core@0.14.0` の配布パッケージ型定義も確認した。`ConversationConfig.preface` は `messages` と `tools` を持ち、`enableConstrainedDecoding` を指定できる。返却 `Message` は `tool_calls` を持つ。また、自動ツール実行用の `AutoToolChat` も公開されている。

SAIVerse Lite では `AutoToolChat` を使わず、既存 `ChatService` のツールループへ tool call をイベント変換して返す方がよい。登録検査、ログ、永続化、最大 4 ラウンド制限を既存の一箇所に保てるためである。

## 4. モデルサイズと端末要件

| モデル | Web 用ファイル | DL サイズ | 公式 Mobile 推論メモリ目安 |
|---|---|---:|---:|
| E2B | `gemma-4-E2B-it-web.litertlm` | 約 2.01 GB | 約 1.1 GB（text-only 約 0.84 GB） |
| E4B | `gemma-4-E4B-it-web.litertlm` | 約 2.97 GB | 約 2.5 GB（text-only 約 2.2 GB） |

推論メモリ目安は静的なモデル重みを中心にした値であり、ブラウザ、WASM、WebGPU、KV cache、長い文脈の追加メモリを含む実機保証ではない。Google の Samsung / iPhone ベンチマークもネイティブ LiteRT-LM の値なので、PWA の性能値として流用してはいけない。

初期提供は次の方針とする。

- 最初は E2B。E4B は高性能端末向けの実験機能とする。
- 理論上の 128K context を初期値にせず、`4096` または `8192` から実測する。
- `navigator.gpu` が無ければ選択不可にし、既存 BYOK provider へ戻せるようにする。
- `navigator.storage.estimate()` で quota / usage を確認してからダウンロードする。
- `navigator.storage.persist()` の結果を表示し、拒否時はブラウザ判断で削除され得ると明示する。
- `navigator.deviceMemory` は概算かつ非対応ブラウザもあるため、唯一の足切り根拠にしない。

## 5. モデルの保存・配布

### 5.1 アプリ配布物へ含めない

Cloudflare Pages / Workers Static Assets の 1 ファイル上限は 25 MiB であり、2～3 GB のモデルは `dist` に同梱できない。モデルは初回だけ次のいずれかから取得する。

1. 検証段階: Hugging Face の LiteRT Community
2. 正式配布: 専用 Cloudflare R2 バケット等

正式配布では次の manifest を固定して持つ。

```ts
interface LocalModelManifest {
  id: "gemma-4-e2b-it-web" | "gemma-4-e4b-it-web";
  runtimeVersion: "0.14.0";
  sourceUrl: string; // main ではなく不変 revision
  byteLength: number;
  sha256: string;
  license: "Apache-2.0";
}
```

Hugging Face の `/resolve/main/` は同じ URL の中身が変わり得る。検証用以外では revision と SHA-256 を固定し、ダウンロード後に照合する。

### 5.2 OPFS に保存する

モデル本体は IndexedDB の巨大レコードではなく、Origin Private File System（OPFS）へ保存する。OPFS の `File` は `Blob` なので、LiteRT-LM の `Engine.create({ model })` に渡せる。

```text
OPFS
  /saiverse-lite-models/
    gemma-4-e2b-it-web-<revision>.litertlm

IndexedDB
  localModels
    id, revision, byteLength, sha256, downloadedBytes,
    status, installedAt, lastVerifiedAt
```

モデル管理は会話・記憶用 `LiteRepository` へ直接混ぜず、別の `LocalModelStore` 抽象層にする。

- モデルは再取得可能な実行資材で、ユーザーの記憶・会話とは寿命が違う。
- 数 GB のモデルをフルバックアップ ZIP に含めない。
- バックアップにはモデル ID、revision、hash のみ記録し、復元時に再取得する。
- アンインストール、破損検査、更新、容量表示を独立して実装できる。

ダウンロードには進捗、キャンセル、`QuotaExceededError` 処理、可能なら HTTP Range 再開を入れる。Service Worker の Cache API へ二重保存しない。

### 5.3 Service Worker

現在の `public/sw.js` は同一 origin の GET を Cache API に保存する。将来モデルを `app.saiverse.net/models/...` で配信すると OPFS と Cache API の両方へ数 GB が入る可能性がある。

モデル URL は別 origin にするか、Service Worker でモデルパスを明示的に除外する。

```js
if (url.pathname.startsWith("/models/")) return;
```

LiteRT-LM の JavaScript / WASM 自体はアプリ配布物へ含め、実行時に CDN から取得しない。PWA shell と同時にオフライン利用できる状態にする。

## 6. SAIVerse Lite への差し込み方

### 6.1 変更箇所

| 場所 | 変更方針 |
|---|---|
| `src/domain.ts` | `ProviderKind` に `litert-local` を追加。API key 前提から分離 |
| `src/llm/index.ts` | `LocalLiteRtProvider` の分岐を追加 |
| `src/llm/types.ts` | 必要なら capability を明示。既存 `ProviderEvent` は再利用可能 |
| `src/chatService.ts` | ローカル provider では API key 必須チェックをしない |
| `src/llm/litertLocal.ts` | LiteRT-LM stream / tool call を既存形式へ変換 |
| `src/storage/modelStore.ts` | OPFS 本体と IndexedDB metadata の抽象層 |
| `src/components/LocalModelView.tsx` | 対応判定、容量、DL、削除、実機 benchmark |
| `public/sw.js` | モデルを Cache API 対象外にする |
| `scripts/gen-licenses.mjs` | Apache-2.0 表示を確認 |

Early Preview の破壊的変更を避けるため依存を完全固定する。

```bash
pnpm add @litert-lm/core@0.14.0 --save-exact
```

`latest` やキャレット範囲にしない。更新時は型差分、実機テスト、モデル再読込を確認する。

### 6.2 Provider adapter

`LocalLiteRtProvider` は既存 `LlmProvider` を実装し、次を担当する。

1. `LocalModelStore` から検証済みモデル `Blob` を取得する。
2. モデルごとに `Engine` を一つ初期化・再利用する。
3. persona の system prompt と固定 tool definitions を先頭へ置く。
4. 長期記憶は固定 head の後、会話履歴の前へ注入する。
5. streaming text を `{ type: "text" }` に変換する。
6. `Message.tool_calls` を `{ type: "tool-call" }` に変換する。
7. `AbortSignal` で `conversation.cancel()` を呼ぶ。
8. Engine / Conversation の破棄と失敗をログへ残す。

Gemma 4 の thinking channel が返る場合、raw reasoning を assistant 本文や会話ログへ混ぜない。最初は final channel だけ表示・保存する。

### 6.3 固定 prefix

persona ごとに固定するもの:

- system prompt
- tool definitions
- model ID / model revision
- prefix 解釈に影響する generation 設定

その後へ自動要約・記憶、thread 履歴、user message、tool result を置く。persona の system prompt または tool IDs が編集された場合は古い conversation を破棄する。

### 6.4 編集・再生成

LiteRT-LM の Conversation は KV cache を持つが、履歴の正典は IndexedDB の `ChatMessage` である。runtime session を正典にしない。

- 通常追記: 同一 persona / thread / model revision の session を再利用してよい。
- 編集・再生成: 変更後の IndexedDB 履歴から session を再構築する。
- thread 切替: 対象履歴から再構築するか LRU 管理された別 session を使う。
- persona / tools / model 変更: session を破棄する。
- アプリ再起動: IndexedDB から復元し、KV cache 永続化は初期実装では行わない。

最初のスパイクは毎回 conversation を作り直して正しさを優先し、その後通常追記だけ再利用してよい。

## 7. ツール呼び出し

v0.14.0 の LiteRT-LM.js は tool definitions と constrained decoding を持つ。初期 2 ツールの単純な object schema は変換可能である。

```ts
const conversation = await engine.createConversation({
  preface: {
    messages: [{ role: "system", content: persona.systemPrompt }],
    tools: mapToolDefinitions(fixedDefinitions),
  },
  enableConstrainedDecoding: true,
  prefillPrefaceOnInit: true,
});
```

これは構造例であり未実装コードである。導入時は固定した v0.14.0 の型定義に合わせる。

`AutoToolChat` は使わず、既存の流れを維持する。

```text
Gemma 4 tool call
  → LocalLiteRtProvider が ProviderEvent へ変換
  → ChatService が persona.toolIds を検査
  → executeTool が実行・ログ・永続化
  → tool message を Gemma 4 へ返す
```

### `memory_recall`

完全オフラインで実行できる。既存 `executeTool()` を利用し、tool call の ID、name、arguments を厳密に検証する。

### `image_generate`

Gemma 4 E2B / E4B は画像理解モデルであり、画像生成モデルではない。さらに Web API は現在 text-in / text-out のみである。

現在の `executeTool()` は会話 provider の `generateImage()` を呼ぶため、ローカル provider だけでは実装できない。次のいずれかが必要になる。

1. persona に画像生成用の別クラウド provider を設定する。
2. ローカル provider 選択時は `image_generate` を登録不可にする。

初期実装は 2 が安全である。1 の場合は「会話は端末内、画像生成時だけ prompt を外部 API へ送る」と明示する。オンデバイス表示のまま黙って外部送信してはいけない。

## 8. UI

「設定 > ローカルモデル」に次を置く。

- WebGPU 対応状態
- 永続ストレージ許可状態
- origin の usage / quota（推定）
- E2B / E4B のダウンロードサイズ
- ダウンロード、再開、キャンセル、削除
- hash 検証状態とモデル初期化テスト
- 実測 TTFT、decode tokens/sec
- 「完全オフライン」または「画像生成のみクラウド」の通信状態

ダウンロード前に数 GB の通信と保存を使うことを確認し、モバイル回線では追加確認を出す。

## 9. 実装順

### A. 最小スパイク

1. `@litert-lm/core@0.14.0` を固定追加する。
2. Android Chrome で `navigator.gpu` を確認する。
3. E2B Web モデルを URL から読み込む。
4. 固定 system prompt 付き 1 往復を streaming 表示する。
5. 停止、Engine 破棄、再初期化を確認する。
6. production build 後、JS / WASM が外部 CDN 依存せず配布物へ入ることを確認する。

### B. SAIVerse Lite 接続

1. `litert-local` provider と adapter を追加する。
2. 通常会話、複数 thread、再生成、編集を通す。
3. system / tools / memory の順序をログで検証する。
4. `memory_recall` の tool call round trip を通す。
5. ローカル provider の画像生成を明示的に無効化する。

### C. 端末保存

1. OPFS `LocalModelStore` を追加する。
2. 容量検査、進捗、キャンセル、破損検査、削除を実装する。
3. PWA 完全終了・再起動後、ネットワークを切って再読込する。
4. Service Worker / OPFS / IndexedDB に二重保存がないことを確認する。

### D. 製品化判定

1. E2B を複数 Android 端末で計測する。
2. E4B は E2B 合格後に同じ試験を行う。
3. iOS PWA は別枠で検証する。
4. tool call の成功率と不正 JSON を固定 fixture で評価する。
5. version pin の更新手順を HANDOFF に追記する。

## 10. テスト項目

### 自動テスト

- LiteRT-LM Message → `ProviderEvent` の text / tool call 変換
- 不明 tool、欠損 ID、不正 arguments の拒否
- AbortSignal → `conversation.cancel()`
- persona / tool / model revision 変更時の session 無効化
- 編集・再生成時の canonical history 再構築
- OPFS metadata round trip
- 中断 DL の再開、破損 hash の拒否
- quota 超過時に会話・記憶 DB を壊さないこと
- backup にモデル binary が混入しないこと

### 実機テスト

- Android 12 以降の Chrome（主対象）
- E2B 初回 / 2 回目ロード、完全オフライン再起動
- 4K / 8K context の TTFT、decode 速度、発熱、強制終了
- 画面ロック、タブ切替、PWA background 復帰
- storage persistence 許可 / 不許可
- `memory_recall` 20～50 ケース
- 長い日本語 system prompt、複数 persona 切替
- iOS Safari / ホーム画面 PWA（実測まで未対応扱い）

## 11. PWA で不足した場合

次が実機で問題になれば、Capacitor のカスタム plugin から Android Kotlin 版 LiteRT-LM を呼ぶ構成へ切り替える。

- Web API の破壊的変更が大きい
- WebGPU / WASM のメモリ不足が多い
- OPFS の数 GB 保存が安定しない
- ネイティブ GPU / NPU 性能が必要
- Web 版にない画像・音声入力が必要

`LocalModelStore` と `LlmProvider` の境界を維持すれば UI、会話、記憶、ツールループは再利用できる。先に PWA adapter 境界を作ることは無駄にならない。

## 12. ライセンスとプライバシー

- LiteRT-LM / `@litert-lm/core` は Apache-2.0。
- E2B / E4B の LiteRT Community 配布物も Apache-2.0 と表示されている。
- Apache-2.0 の依存物は AGPL-3.0-only の SAIVerse Lite から利用可能。著作権表示、ライセンス本文、NOTICE がある場合の表示を保持する。
- npm package は既存の third-party license 生成へ含める。モデルは npm 依存ではないので、モデル管理画面と第三者ライセンス画面へ名称、revision、配布元、Apache-2.0 を別途表示する。
- 改変した SAIVerse Lite をネットワーク越しに提供する場合の AGPL ソース提供義務は従来どおり維持する。
- ローカル会話では prompt、persona、記憶を推論目的で外部送信しない。ただしモデル初回 DL は通信する。
- `image_generate` をクラウドへルーティングする場合は完全オフラインではないため、送信前に明示する。

## 13. 未検証事項

- SAIVerse Lite に package を追加した production build
- `app.saiverse.net` での WASM / WebGPU 初期化
- Android 実機での E2B / E4B の速度、メモリ、発熱
- OPFS へ 2 GB / 3 GB 保存時の端末別 quota
- PWA 再起動後の完全オフライン再読込
- v0.14.0 streaming tool call の安定性
- 日本語 persona prompt と長期記憶注入時の品質
- iOS Safari / ホーム画面 PWA の実用性
- Hugging Face 直接配布を続ける場合の帯域・利用条件

確認前に README の「検証済み」へローカル Gemma 対応を加えてはいけない。

## 14. 参照資料

一次資料を優先した。内容は 2026-07-16 時点。

- [LiteRT-LM Overview](https://developers.google.com/edge/litert-lm/overview)
- [LiteRT-LM Web API](https://developers.google.com/edge/litert-lm/js)
- [LiteRT-LM v0.14.0 release](https://github.com/google-ai-edge/LiteRT-LM/releases/tag/v0.14.0)
- [Google AI Edge Gallery](https://github.com/google-ai-edge/gallery)
- [Gemma 4 model overview](https://ai.google.dev/gemma/docs/core)
- [Gemma 4 E2B LiteRT-LM files](https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/tree/main)
- [Gemma 4 E4B LiteRT-LM files](https://huggingface.co/litert-community/gemma-4-E4B-it-litert-lm/tree/main)
- [Origin private file system](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system)
- [Storage quotas and eviction criteria](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)
- [Cloudflare Pages limits](https://developers.cloudflare.com/pages/platform/limits/)
