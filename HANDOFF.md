# HANDOFF

## 納品時点

SAIVerse Lite v1 の骨格を、独立した git リポジトリとして構築しました。
SAIVerse 本体リポジトリと `~/.saiverse` には書き込んでいません。

検証結果は README の「検証済み / 未検証」を参照してください。未検証項目を動作済みとは
扱っていません。

## 主な設計判断

### ローカルファーストの境界

全永続データは `LiteRepository` を通します。ブラウザ実装は IndexedDB、テスト実装は
メモリで、UI と会話サービスは IndexedDB を直接知りません。起動時には
`navigator.storage.persist()` を要求します。バックアップ復元が全ストアを置換するため、
形式の検証後にだけ restore を実行します。

API キーは provider レコードに端末内保存しますが、`saiverse_lite_backup_v1` の生成時に
必ず空文字へ置換します。

### 互換形式

`FORMATS.md` を唯一の形式正典にしました。SAIVerse 本体の現行 importer / exporter を読み、
会話と記憶は本体が受理する `saiverse_saimemory_v1` として出力します。Lite 独自 ID と
記憶種別は、既存 importer が保持する metadata と synthetic memory thread に載せています。

ペルソナファイルには、本体の `BlueprintCreate` と同形の `saiverse_blueprint` を併記します。
ただし本体には現時点でペルソナファイル用 import endpoint がなく、移植時に必須となる
`city_id` もポータブルではありません。本体側の受け口実装と end-to-end 検証が必要です。

### 固定 prefix と記憶注入

system prompt と tool definitions はペルソナに保存し、ターンごとに変えません。動的な記憶
ブロックは固定 head の後、直近会話の前に置きます。自動要約の閾値、対象 message ID、
注入順は `FORMATS.md` に記載し、サービス実装とテストを一致させました。

### Gemini auto cache

既定で有効です。概算 1024 token 以上の固定 prefix に対して cachedContents を作り、
生成リクエストへ `cachedContent` を渡し、成功・失敗にかかわらず `finally` で削除します。
短い prefix、cache create の非成功応答、create 例外ではログを残して inline 通常呼び出しへ
silent fallback します。実 API での token 判定・課金効果は未検証です。

### OpenAI Responses API

公式 OpenAI は `/v1/responses` を使用し、OpenAI 互換 URL は互換性維持のため
`/v1/chat/completions` を使用します。Responses API は `store: false` とし、OpenAI
側の会話保存には依存しません。推論モデルの function calling を継続するため、レスポンスの
opaque output items（暗号化 reasoning item を含む）を `lite_provider_state` として端末内に
保存し、次のツールラウンドへそのまま返します。実 API キーでの通信は未検証です。

### ツール

ツールはレジストリ方式で、ペルソナの `toolIds` に登録されたものだけを各社の native
function calling へ渡します。初期ツールは `memory_recall` と `image_generate` です。
ツールループは無限実行を避けるため上限を持ち、開始・完了・失敗をログへ残します。

## 意図的に推測しなかった箇所

Claude 公式エクスポートの実サンプルを利用できませんでした。ChatGPT と同じ
`conversations.json` という名前だけを根拠に互換パーサを作ることはしていません。
source 別 importer interface と Claude adapter は用意し、Claude adapter は
`UnverifiedClaudeSchemaError` を返します。実データ入手後に、フィールド、分岐、時刻、
hidden message、添付・tool result の扱いを確認してから実装してください。

## 次に実データで確認する項目

1. 各プロバイダの実キー・実モデルで、ストリーム終端と native tool-call payload を確認する。
   OpenAI は Responses API の reasoning item → function call → function output の連鎖も確認する。
2. Gemini cache が作成される長い固定 prefix と、作成不能な短い prefix の双方をログで確認する。
3. ChatGPT の実 ZIP、大容量履歴、添付・tool result を含むデータで import 結果を照合する。
4. Claude 公式エクスポートの匿名化サンプルから adapter と fixture を実装する。
5. 本体 importer へ `saiverse_saimemory_v1` を投入し、会話・記憶・metadata を照合する。
6. 本体側の persona import 受け口を決め、都市選択を含む導線を検証する。
7. iOS / Android の実機で install、offline shell、`storage.persist()` の結果を確認する。

## スキップした範囲

intent の v1.x、v2、恒久非搭載に分類された機能は実装していません。具体的には、
キャラクター間関係、ナレーター統合、共有世界 / 都市シミュレーション、ローカル LLM、
分岐ストーリー管理、複数ペルソナ同時会話、本体との常時同期、生活シミュレーション、
タイムライン、バックグラウンド自律稼働、AI 間自動会話を含みます。
