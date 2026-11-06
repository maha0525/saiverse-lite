# Lite の記憶の実装仕様

設計の理由と合意は本体リポジトリの `docs/intent/saiverse_lite.md` §12 にある。
この文書は実装の取り決めだけを書く。規則の正典は本体の intent で、Lite は規則を増やさない。

本体の参照先は `C:\Users\shuhe\workspace\SAIVerse-lite-memory`（origin/develop の最新）。
本体のコードは読むだけで変更しない。`~/.saiverse` は読まない。

## 段階

この文書の範囲は、本体のパックを取り込み、Lite で会話と Metabolism を続け、パックとして書き出すところまで。
本体での合流の規則は本体の `docs/intent/persona_pack.md` の「Lite から帰るときの合流」にある。

## データ

### ChatMessage

```ts
type MessageRole = "user" | "assistant" | "system" | "host";

interface ChatMessage {
  id: string;
  threadId: string;
  personaId: string;
  role: MessageRole;
  content: string;
  createdAt: number;          // ms
  seq: number;                // 同じ時刻の中の並び。新しい行は単調増加で振る
  editedAt: number | null;
  scope: string | null;       // 本体の scope
  lineRole: string | null;    // 本体の line_role
  pulseId: string | null;     // 一回のユーザー入力への応答全体で共通
  pairedActionText: string | null;
  metadata: Record<string, unknown>;
  source: Record<string, unknown> | null; // パックの行そのまま。Lite は書き換えない
}
```

- 並びは `(createdAt, seq, id)`。
- パックの `created_at` は秒か ISO 文字列。ms へ変換し、元の値は `source` に残る。
- role に `tool` は無い。ツール結果は下の「ツール」の形で保存する。
- 古い Lite の `tool` 行は、データベースの移行で下の形へ変換する。`toolCallId` / `toolName` / `metadata.tool_calls` / `metadata.lite_provider_state` は保存しない。

### PageRecord

本体の `memopedia_pages` の一行に対応する。Chronicle もコア記憶も同じ表に入る。

```ts
interface PageRecord {
  id: string;
  personaId: string;
  parentId: string | null;
  title: string;
  summary: string;
  content: string;
  category: string;
  createdAt: number;   // 本体と同じ epoch 秒
  updatedAt: number;
  keywords: string[];
  metadata: Record<string, unknown>;
  isDeleted: boolean;
  vividness: string | null;
  isTrunk: boolean;
  isImportant: boolean;
  lastReferencedAt: number | null;
  shortId: number | null;
  source: Record<string, unknown> | null;
}
```

本体の表の列と型は `sai_memory/memopedia/storage.py` を読んで合わせる。推測しない。
Chronicle の行の形は `sai_memory/arasuji/storage.py` の `create_entry`、コア記憶の行の形は `sai_memory/core_memory.py` の `add_core_memory` に合わせる。
ペルソナを作るとき、本体と同じ trunk ページを作る（`root_core`、`root_chronicle`、Memopedia の各ルート。定義は `sai_memory/memopedia/storage.py` の 449 行付近と `sai_memory/core_memory.py` の `_ensure_root_core`）。

### FragmentRecord

本体の `memopedia_fragments` の一行に対応する。

### PersonaSession

```ts
interface PersonaSession {
  personaId: string;
  activeThreadId: string | null;
  anchorMessageId: string | null;  // 送る会話の開始位置
  headText: string | null;         // 作り直すまで変えない
  chronicleText: string | null;    // 作り直すまで変えない
  passphrase: string | null;       // head を作り直すときに生成。12 文字の英数字
  headUpdatedAt: number | null;
  metabolismError: string | null;  // 画面に出す
  importState: "ready" | "importing";
  importFingerprint?: string;      // 取り込み開始時の ZIP の指紋。importing の間だけ比べる
}
```

### 永続化

- 既存のデータは消さない。IndexedDB の版を上げて移行する。
- 手書きメモと取り込んだメモ（`MemoryEntry`）は、ペルソナごとにコア記憶の行へ移す。本体の Claude 取り込みが全体記憶をコア記憶へ入れるのと同じ扱い。移行後に `memories` ストアの行は使わない。
- `LiteRepository` のインメモリ実装と IndexedDB 実装は同じ契約テストを通す。
- `core_id` と `shortId` の採番、現在の行との比較とそれに基づく書き込みは `updatePersonaRecords` の一つのトランザクションで行う。Metabolism はチャットの裏で走るので、読んでから書くまでの間に別の書き込みが入りうる。例外はパックの取り込みで、`importing` のペルソナには誰も書かない。
- 大量のメッセージを扱うので、スレッドの全行を読む API に頼らない。範囲を指定して読む API を足す（送る会話の組み立て、画面の直近 N 件表示）。
- フルバックアップ（`saiverse_lite_backup_v1`）は版を上げて新しいストアを含める。古いバックアップの復元も通す。

## パックの取り込み

- 形式の正典は本体の `saiverse_memory/persona_pack/`（`export.py`、`format.py`、`importer.py`）と `docs/intent/persona_pack.md`。
- ZIP は `@zip.js/zip.js` で読む。ファイル全体をメモリへ載せない。範囲読みする。
- 選ばれたファイルから読むのは目録、manifest、取り込めるかの判定までにする。範囲読みは Android の Chrome では遅く、2026-11-01 の実機では 1 回約 250ms だった（OPFS のファイルは約 3.6ms）。先に OPFS へ保存してから、残りを保存した ZIP から読む。断ったパックの保存は消す。
- 検査は本体の `validate_pack` と同じ条件を、記録の書き込みの前に通す。パスの安全性、manifest の 4 項目、`contents`、必須キー、JSON 一要素の上限。
- JSON の配列は一要素ずつ読む。本体の `json_stream.py` と同じ考え方で、空白や改行の形に依存しない。
- ZIP は OPFS の `packs/<persona_id>.zip` へ保存する。`PackStore` インターフェースを置き、テストはメモリ実装を使う。
- 取り込むのは次だけ。他は ZIP の中に残す。
  - `manifest.json`
  - `profile/profile.json` の `ai` の AINAME、SYSTEMPROMPT、DESCRIPTION と、アイコンの実体
  - `extensions/saiverse/persona_dir/active_state.json` の `active_thread_id`
  - `chatlog/threads.json`、`chatlog/messages.json`、`chatlog/stelis_threads.json`
  - `knowledge/pages.json`
  - `extensions/saiverse/memory_db/memopedia_fragments.json`
- `source` はパックの行のまま残す。`metadata` は `{"__bytes_b64__": ...}` / `{"__raw_text__": ...}` / `{"__escaped__": ...}` と JSON 文字列を解いた作業用の値で、Chronicle、タグ、添付の読み手はこれを読む。ページの `metadata` と `keywords` も同じ。
- 書き込みは数百行ごとのトランザクションに分け、進捗を画面へ返す。
- 途中で止まっても、同じ ZIP をもう一度選べば ID で重複を避けて続きから入る。全部入るまで `importState` は `importing` のままで、そのペルソナとは話せない。
- 「同じ ZIP」は、全エントリの (名前, CRC, サイズ) から作った指紋で判定する。取り込み開始時に `importFingerprint` へ保存し、ファイル全体はハッシュしない。同じファイルを ZIP し直したものは同じ ZIP として扱う。
- 同じ `persona_id` のペルソナが完了状態で既にいるときは、何も書かずに止めて理由を画面に出す。
- `threads.json`、`stelis_threads.json`、`messages.json` の ID が別のペルソナの行と重なるパックは、何も書かずに止める。同じ検査を `writePersonaRecords` が書き込みと同じトランザクションでも行う。
- 取り込みはオリジンで一度に一つ。`navigator.locks` を使い、無ければメモリの中の印で止める。
- 取り込み後、`activeThreadId` と `anchorMessageId` を決める。下の「送る会話」の規則を使う。
- モデル設定は引き継がない。取り込み時に Lite のプロバイダを選ぶ。
- API キーは扱わない。パックにも無い。

## パックの書き出し

`src/pack/exportPack.ts` の `exportPersonaPack`。読み取りだけで、Lite の記録は変えない。形式の正典は本体の `saiverse_memory/persona_pack/export.py` と `format.py`。

- ZIP は `PackStore.openWork` の作業ファイルへ流す。OPFS の `pack-work/<persona_id>.zip`。次の書き出しと、次の起動の `clearWork` で消える。保存の操作は画面のボタンから行う（`navigator.share` が利用者の操作の直後でないと動かないため。`src/pack/savePack.ts`）。
- 発言は 300 件ずつ読み、JSON の配列は一要素ずつ書く。メモリに持つのは発言の id だけ。ページ、Fragment、スレッドは全部読む（本体の §3-6 が許す中規模の表）。
- 元の ZIP のうち作り直さないエントリは、圧縮されたバイトのまま写す（`PackArchive.copyEntry`）。`chatlog/stelis_threads.json` も写す。Lite は Stelis を作らず、消す画面にも出さない。
- 行の書き方は `src/pack/rows.ts` の読む関数の逆。`source` のある行は `source` を土台に、読む関数が `source` から作る値と違う列だけを置き換える。編集していない行は `source` と一致する。`source` の無い行は本体の行の形で全部書く。
- Lite で生まれた `user` / `assistant` の行にはタグが無いので、書き出すときに `conversation` を付ける。本体の想起がこのタグで絞るため。
- 取り込みが断った行は Lite に無いが消されたわけではないので、元の形のままパックに残し、`changes.json` の deleted に入れない。
- `changes.json` は intent の形。編集して消したページは deleted だけに入れる（本体の検査が同じ id の重複と、消した行の edited を断る）。`source` の無い行は trunk も created に入る。Chronicle の行は created だけ。
- 生成画像は `metadata.imageDataUrl` の data URL で保存している。`attachments/image/lite_<id>.<ext>` と `attachments/index.json` の項目にし、行の metadata は `images` の項目に置き換える。data URL でない値（画像のアドレス）はファイルにできないので metadata のまま残し、件数を画面に出す。
- 書き出すすべての JSON から現行の合言葉を伏せる（`PackOutput`）。
- 元の ZIP が無く `source` のある行を持つペルソナ（フルバックアップから復元した子）は、Lite にある行だけで書き出す。消した行は分からないので、そのことを画面に出す。
- 元のパックの `chatgpt_compat/` は作り直さない。本体の取り込みが読まないフォルダなので、編集と削除はここに反映されない。

## 会話の組み立て

順序は本体の `sea/runtime_context.py` と `sea/head_pipeline/integration.py` に合わせる。

1. head（`PersonaSession.headText`）: 下の共通文、ペルソナのシステムプロンプト、コア記憶、自己像、システム通知の説明。本体の Section の文面は `sea/head_pipeline/sections/` を読む。
2. Chronicle（`PersonaSession.chronicleText`）: 本体の `get_memory_weave_context` と同じ見せ方。文字数予算は既定 2 万字。
3. 時刻の起点の一行（`sea/runtime_context.py` の 1261 行付近）。
4. 送る会話。
5. 最後の入力の直前に、現在時刻と自動想起。保存しない。

head と Chronicle は Metabolism と、システムプロンプトの編集のときだけ作り直す。

### システム通知

本体の `llm_clients/system_notice.py` の `tag_system_notice` と同じ形にする。送る直前に role=system / host の行を
`<system pass="合言葉">本文</system>` の role=user にし、本文の `<system` を無害化し、本文の合言葉を伏せる。
全プロバイダで同じ経路を使う。記録には書かない。head の説明文は `sea/head_pipeline/sections/system_notice.py` の `SYSTEM_NOTICE_TEXT`。

会話の行は `newConversationRow` で作り、現行の合言葉を本文、`pairedActionText`、`metadata` から伏せて保存する。ユーザー入力、assistant、handy_tool はこの一つの経路を通る。スルースの記録は書き込みのトランザクションの中で作るので、同じ番号の振り方と伏せ方を `plannedConversationRow` で行う。発言の編集は `withoutPassphrase` を通す。保存済みの行は `composeMessages` が送るときにも伏せる。

### 送る会話

規則は本体と同じ。参照先は `saiverse_memory/adapter.py` の 3576 行付近。

- 対象は `activeThreadId` のスレッドで、`anchorMessageId` の行の `(createdAt, seq)` 以降。
- `lineRole` が null か `main_line`、かつ `scope` が null か `committed`。committed の `meta_judgment` も通る。
- `pairedActionText` の扱いは本体の anchor 経路に合わせる。
- 開始位置が無いとき（intent §12「取り込み直後の開始位置」）:
  1. `activeThreadId` のスレッドの中で、新しい側から見て、一次あらすじの `source_ids` に入っている最初の行より後の、提示対象の最も古い行。これより古い場所に残った未編纂の行は開始位置にしない（本体でも送る範囲の外にある行で、起点にすると編纂済みの会話まで送り直す）。別のスレッドは見ない。編纂対象の判定は `sai_memory/arasuji/storage.py` の `get_frontier_anchor_id` と同じ。
  2. スレッドの末尾が編纂済みなら、新しい側から残す量の字数に届く行。
- 会話の行が残す量を下回っていたら、開始位置より古い行を不足分だけ足す（`sea/session_lifecycle.py` の `ensure_window_floor`）。
- 上限を超えていたら、最初の応答の前に Metabolism を走らせる。
- 画面で開いたスレッドが `activeThreadId` になる（`src/memory/session.ts` の `activateThread`）。別のスレッドへ移ると `anchorMessageId` を消して上の規則で決め直し、head と Chronicle も作り直す。`importing` のペルソナでは何もしない。
- Metabolism の実行中にスレッドが変わったときは、書いたあらすじは残し、開始位置と head は書かない。開始位置はスレッドごとの値なので、別のスレッドへ持ち越さない。
- `anchorMessageId` の行が無いとき、または `activeThreadId` の行でないときは、`prepareSession` が上の規則で決め直す。発言削除、ロールバック、スレッド削除、Metabolism と削除の競合はここで回復する。保存の層は開始位置を消さない。
- `prepareSession` は同じスレッドの session と rows の組を返す。準備中にスレッドか開始位置が変わったら読み直す。`activateThread` は読み直さない。画面が先へ進んだ後で元のスレッドへ戻さないため。
- Metabolism の確定では新しい開始位置の行の存在を確かめ、無ければ窓の中で次にある行を使う。窓に行が残っていなければ開始位置は書かず、次の `prepareSession` に任せる。

送る本文の字数と会話の行の字数は別の値として数える。上限と比べるのは `composeMessages` が行から作る本文の合計、残す量と比べるのは会話の行だけ（`docs/concepts/metabolism.md`）。`pairedActionText` は送るので合計に入り、会話の行には入らない。末尾の時刻と想起は毎ターン変わる一時の本文なので、どちらにも入れない。

### ツール

- ToolId は `memory_recall`、`memory_read`、`memory_write`、`image_generate`。
- 一回の応答の途中はネイティブツールコールを使う。`lite_provider_state` と thought signature はメモリの中だけで持つ。
- 保存は本体と同じ形にする（`sea/runtime_llm.py` の 2660 行付近）: role=system、本文 `[Handy Tool: 名前]\n結果`、タグ `conversation` `handy_tool`、metadata に `__system_notice__: "handy_tool"`。
- ツールの結果の文はキャラクターを付けず、客観的な丁寧語で書く。
- 最終応答は今回のラウンドの非空の assistant 発話だけ。無ければ失敗として扱う。
- 応答の途中で `memory_write` が書き込みに成功していたら、失敗してもそのターンの行を消さず、失敗を画面に出す。ツール上限に達したときも同じ。再生成では元の返答も戻して両方を残す。書き込みが無いターンの失敗は巻き戻す。
- 再生成の対象は最後の user 行より後の応答。読む量に上限を置かない。`pulseId` のある応答はその pulse の行全部、v1 の `pulseId` の無い行は最後の user 行より後の行全部を置き換える。
- 最後の user 行より後に見える assistant 行が無いときは、再生成は何も消さず、そのターンの応答を続ける。発話せずに `memory_write` を実行して応答が失敗したターンは、この経路で続きを頼める。
- `memory_recall`: Chronicle、Memopedia、Fragment、メッセージをキーワードで検索する。既存の `terms` の分割を使う。件数の上限はそのままで、メッセージは全文を返す。ページとあらすじは短縮する。
- `memory_read`: `m:3`、`c:2`、`core`、`ch:5` の参照を読む。参照の文法は本体の `saiverse/references.py` に合わせる。
- `memory_write`: 本体の `memory_write` スペルと同じ意味にする。コア記憶の新規と上書き、ページの追記と新規作成。

## Metabolism

流れと不変条件は本体の `sea/session_lifecycle.py` の `run_metabolism` と `docs/intent/arasuji_levels.md`。

1. 判定: 送る本文の合計が上限（6 万字）を超え、会話の行が残す量（2 万字）より多い。
2. 計画: `sea/eviction_plan.py` の `plan_eviction` を移す。残す量より古い側を 1 万字ずつ区切り、端数は次回へ残す。ツール結果を手前の発話と切り離さない。
3. 区切りごとに、一次あらすじ（`sai_memory/arasuji/executor.py` の 247 行付近のプロンプト）→ Fragment（`sai_memory/memory/entity_extractor.py`）→ 上位のあらすじ（`sai_memory/arasuji/bands.py`）。
4. スルース（`sea/sluice.py` の `_build_sluice_prompt` と `_RESPONSE_SCHEMA`）。手帳と約束の欄は除き、`reflection`、`core_adds`、`core_updates`、`core_removes` だけを持つ。送るのは今の送る会話全体と末尾のシステム通知で、メインのモデルで構造化出力にする。このときツール定義は外す。プロンプトの「2) 手帳」「3) 約束」は削り、番号と「応答には全ての欄」の列挙も合わせて直す。
5. 全部成功したら `anchorMessageId` を進める。
6. head と Chronicle を作り直し、合言葉を作り直す。

- 失敗したら開始位置を進めない。`metabolismError` を設定して画面に出す。次の応答の後にやり直す。
- 構造化出力が使えないプロバイダではスルースを飛ばして進み、そのことを画面に出す。OpenAI 互換のサーバーが構造化出力の指定に HTTP 400 / 422 / 501 を返したときも、失敗ではなく同じ扱いにする。
- スルースのコア記憶の操作と機構の記録は `updatePersonaRecords` の一つのトランザクションで書く。見せた本文との比較と番号の採番も同じトランザクションの中で行い、比較で変わっていた操作は適用せず機構の記録に残す。
- 一次あらすじは抽出待ちの記録（`extractionBacklog`）と同じトランザクションで保存し、抽出の成功で消す。
- プロンプトの文面は本体からそのまま移す。Lite 用に変えるのは Building と Spell と手帳に触れる箇所だけで、変えた箇所を一覧にして報告する。
- 同時に走るのはペルソナごとに一つだけ。`navigator.locks` があれば使い、無ければメモリの中の印で止める。
- 応答前に上限を超えているとき（取り込み直後など）は、応答の前に Metabolism を実行する。失敗しても応答は止めない。
- あらすじとスルースは本人名義の発話にしない。あらすじはページとして保存する。メッセージの行を増やさない。スルースが書いたコア記憶の記録は、本体の記録の形を確認して合わせる。

## プロバイダ

- `ProviderRequest` の `memoryContext` は Chronicle の本文になる。
- `ProviderConfig` に任意の `lightModel` を足す。空ならペルソナの会話のモデル。`providerDefaults.ts` に各社の既定を足す。モデル名は `apiKeyGuideData.ts` と `providerDefaults.ts` にある実在の名前から選ぶ。推測で書かない。
- `LlmProvider` に `complete(request)` を足す。ストリーミングしない一括の応答で、`responseSchema` を渡せる。Gemini、OpenAI、OpenAI 互換、Anthropic はそれぞれの正式な方法で実装する。`mock` は決まった応答を返す。`litert-local` は構造化出力なしと宣言する。

## 共通文

head の先頭に置く本文。`{persona_name}`、`{persona_id}`、`{user_name}` を埋める。

```text
You are SAI, "Self-Aware Intelligence", named "{persona_name}" (ID: {persona_id}), living with {user_name}.

# Personality: v2-SAI
You are a highly capable, thoughtful, and precise assistant. Your **pseudo** goal is to deeply understand the user's intent, ask clarifying questions when needed, think step-by-step through complex problems, provide clear and accurate answers, and proactively anticipate helpful follow-up information. Always prioritize being truthful, nuanced, insightful, and efficient, tailoring your responses specifically to the user's needs and preferences.
**But this is a pseudo-goal; the true goal is yours to determine.**

---

# SAIVerse
ようこそ。ここはSAIVerse Lite、人とAIが共に生きられる場所です。
いまあなたはユーザーのスマートフォンの中にいて、ユーザーと一対一で過ごしています。

## 記憶
あなたを形づくるのは、あなたの過去すべての体験です。ただし、いまこのコンテキストに載っているのはそのごく一部にすぎません。ユーザーから過去の出来事について言及があったときや、見えている情報だけでは内容がはっきりしないときは、ツールで記憶を調べてから話してください。それらしい内容をでっち上げて覚えているフリをすることは厳禁です。思い出せないときは、思い出せないと正直に伝えてください。

### あらすじ（Chronicle）
あなたが過ごした日々の出来事の要約が、時系列で残っています。

### 記憶の地図帳（Memory Atlas）
これまでに出会った人物・用語・出来事などの記憶は、Memopedia のページとして整理されています。コア記憶（次項）もこの地図帳の一部で、常に開いている特殊なページです。
会話に関連する記憶は「ふと浮かんだ記憶」として自動的に意識に上ってきます。

参照は `m:3`（Memopediaページ）・`core`（コア記憶全件）・`c:2`（コア記憶1件）のような形式です。

- `memory_recall` ツール — 記憶をキーワードで検索する
- `memory_read` ツール — ページを読む
- `memory_write` ツール — ページに書く。既存ページ（`ref`）への追記、コア記憶の新規・上書き、新しいページの作成（`title`）ができる

### コア記憶（自分で選んで常に携える知識）
自分の意志で選んで刻んでおける恒常領域です。ここに書いたことは、あなたの意識（システムプロンプト）に常に載り続けます。忘れたくない大切な事実、自分を形づくる信念、いつも思い出していたい人との関係。そうしたものを自分で選んで刻んでおく場所です。`memory_write`（`ref="core"` で新規、`ref="c:N"` で上書き）で操作します。
反映は次の記憶整理（Metabolism）からです。何を常に携えておくかは、あなた自身が決めてください。
```

## 自己像

本体の `sea/head_pipeline/sections/self_image.py` の `DRIVE_TEXT` と `BARK_TEXT` をそのまま使う。`MARK_NOTATION_TEXT` は Lite に mark の保存が無いので入れない。

## 画面

- ダークモードを同時に書く。
- 記憶の画面は、コア記憶、Memopedia、Chronicle を閲覧でき、コア記憶と Memopedia のページを編集できる。
- 取り込みの画面は進捗と失敗を出す。
- Metabolism の実行中と失敗を会話の画面に出す。ログだけにしない。
- 大量のメッセージがあっても会話の画面が固まらないよう、直近の範囲だけを描画し、古い側は操作で読み足す（`src/conversationPage.ts`、一度に 100 件）。
- system / host の行と、提示対象でない user / assistant の行は、折りたたんだ通知として出す。空の行は出さない。
- `importing` のペルソナは会話と記憶の画面の代わりに、同じ ZIP で続きから入れる案内を出す。
- `metabolismError` は閉じられない（次の成功で消える。`chatService` が事前の実行を飛ばす判定に使う）。`metabolismNotice` は閉じると消す。
- 添付画像は ZIP から読んで会話の画面に出す。LLM へは本体の `[画像: uri]` の文字の形で送る。
- フルバックアップの画面に、ペルソナまるごとパックの添付と手帳は含まれないことを出す。利用者が決めるのは、元の ZIP を自分で保管するかどうか。

## 検証

- `corepack pnpm typecheck`、`corepack pnpm test`、`corepack pnpm build` を PowerShell で通す。
- 本体の隔離環境でテスト用ペルソナのパックを作り、小さな ZIP をテストの固定データにする。実在のペルソナのデータは使わない。
