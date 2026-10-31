import type { ChatMessage, ExtractionBacklogItem, FragmentRecord, PageRecord } from "../domain";
import { CATEGORY_CHRONICLE, epochSeconds } from "../pageRecords";
import type { LiteRepository } from "../storage/repository";
import { auxiliaryRequest, episodeContextForTimerange, type AuxiliaryLlm } from "./chronicle";
import { chronicleEntry, formatDate, formatTimestamp } from "./entries";
import {
  DEFAULT_MEMOPEDIA_CATEGORY,
  findPageByTitle,
  formatPageList,
  fragmentRecord,
  isMemopediaCategory,
  memopediaPage,
  MEMOPEDIA_CATEGORIES,
} from "./memopedia";

// A port of the body's sai_memory/memory/entity_extractor.py. `involved_entities`
// stays in the prompt, but Lite has no chunk_page_edges table to write it to.

const EPISODE_CONTEXT_ENTRIES = 10;
/** body: MAX_EXTRACTION_RETRIES. An item past it stays in the backlog, unprocessed. */
const MAX_EXTRACTION_RETRIES = 3;

export class ExtractionFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtractionFailed";
  }
}

interface ExtractedEntity {
  name: string;
  category: string;
  summary: string;
  notes: string[];
}

const EXTRACTION_FORMAT_EXAMPLE = JSON.stringify({
  entities: [
    {
      name: "エンティティ名",
      category: "people",
      summary: "このエンティティが何であるかの一文定義",
      notes: ["文脈を含む事実1", "文脈を含む事実2"],
    },
  ],
  involved_entities: ["既存ページのタイトル1", "既存ページのタイトル2"],
}, null, 2);

/** body: `_build_extraction_prompt`. */
function buildExtractionPrompt(conversation: string, episodeContext: string, existingPages: string): string {
  const parts = [
    "あなたは知識ベースの整理係です。以下の会話に登場する固有の対象（エンティティ）を認識し、各エンティティについて新たに判明した情報を抽出してください。",
    "",
    "## エンティティとは",
    "",
    "Memopedia（知識ベース）でページを持つべき固有の対象物です。",
    "- 人物: ユーザー、友人、家族など（例: まはー、ナチュレ）",
    "- AI: AIペルソナ、AIプロジェクト（例: エイド、エリス）",
    "- プロジェクト/作品: ソフトウェア、ゲーム、創作物（例: SAIVerse、Project N.E.K.O.）",
    "- 用語/概念: 固有の技術用語、独自概念（例: Playbook、マザーAI法）",
    "- 場所: 固有名を持つ場所（例: 創造の祭壇）",
    "- イベント: 固有の出来事（例: ぽこあポケモン発売）",
    "",
    "**エンティティではないもの**:",
    "- 一般名詞や抽象概念",
    "- Wikipediaや検索エンジンで調べれば誰でも分かるもの（広く知られたサービス、技術用語、プログラミング言語、ツール名など）",
    "- ファイル名、パス、CLIコマンド名",
    "- IDやハッシュ値、ランダムな文字列、メールアドレス",
    "- APIスコープ名、認証トークン、パスワード等の技術的な識別子",
    "- その場限りのエラーメッセージやステータス",
    "",
    "**判定基準**: 「これは会話の当事者たちの間でだけ通じる固有の対象か？」",
    "世間一般に知られている事物は、この人たちの個人的な知識ベースに記録する必要はありません。",
    "当事者たちの関係性・創作・プロジェクトに固有の対象だけを記録してください。",
    "",
    "## 会話当事者についての注意",
    "",
    "会話の当事者（ペルソナ自身、ユーザー、頻繁に登場するAI）については、**6ヶ月後でも変わらない恒久的な属性のみ**を記録してください。",
    "",
    "記録すべき（恒久的な属性）:",
    "- 誕生日、好き嫌い、価値観、信念、性格的特徴",
    "- 人間関係や関係性の定義",
    "- 恒久的な習慣や癖",
    "",
    "記録すべきでない（行動記録・一時的な状態）:",
    "- 「〜した」「〜を行った」「〜を試みた」「〜に成功した」のような行動の記録",
    "- 「〜に直面している」「〜を感じている」のような一時的な状態",
    "- 作業の詳細や手順",
    "",
    "悪い例（行動記録であり、Chronicleの仕事）:",
    "- 「設定ファイルを編集して問題を解決した」",
    "- 「長時間の作業により疲労を感じている」",
    "",
    "良い例（恒久的な属性）:",
    "- 「几帳面な性格で、細部にこだわる傾向がある」",
    "- 「物語の中に驚きや成長の要素があることを好む」",
    "",
  ];
  if (episodeContext) parts.push("## これまでの流れ（参考）", episodeContext, "");
  if (existingPages) {
    parts.push(
      "## 既存のMemopediaページ一覧",
      "以下のページが既に存在します。同名のエンティティが会話に登場した場合は、既に記録済みの情報と重複しないよう、新たに判明した情報のみを抽出してください。一覧にないエンティティが会話に登場した場合は新規として抽出してください。",
      existingPages,
      "",
    );
  }
  parts.push(
    "## 今回の会話",
    conversation,
    "",
    "## 指示",
    "",
    "- 会話に登場するエンティティ（固有名詞を持つ対象）を列挙してください",
    "- 各エンティティについて **summary**（そのエンティティが何であるかの一文定義）を書いてください",
    "  - 例: 「ソフィーの一人であるAIペルソナ」「まはーが開発しているAIプラットフォーム」",
    "  - 既存ページにあるエンティティでも、summaryは毎回書いてください",
    "- 各エンティティについて、この会話で新たに判明した事実・属性・状態変化を **notes** として記録してください",
    "- **notesは、その情報単体で意味が通じるように書いてください**。エンティティ名のページに記載される情報なので、",
    "  「このエンティティは何か」という前提知識がない読者でも理解できる文脈を含めてください",
    "  - 悪い例: 「元コードネームは「γ」である」（何の文脈か不明）",
    "  - 良い例: 「SAIVerseの開発初期にはコードネーム「γ」で呼ばれていた」",
    "- notesは短い1文で記述してください（「〜である」「〜が判明した」等）",
    "- 会話の中で明確に述べられた事実のみを抽出してください（推測や解釈は含めない）",
    "- 既存ページに記録済みの情報と重複するnotesは除外してください",
    "- 抽出すべきエンティティがない場合は空のリストを返してください",
    `- categoryは ${MEMOPEDIA_CATEGORIES.join(" / ")} のいずれかを指定してください`,
    "- 日本語で出力してください",
    "",
    "## この会話が関与した対象（involved_entities）",
    "",
    "上の抽出とは**別の仕事**です。新しく判明した情報の有無に関係なく、この会話が関わった対象を列挙してください。",
    "",
    "- 「関わった」とは、その対象について話した／その対象のための調べ物・作業・準備をした、ということです",
    "- **新しく判明した情報が無くても列挙してください**。entities に挙がらなかった対象こそ、ここで拾う価値があります",
    "- 既存のMemopediaページ一覧にあるタイトルを、**一覧に書かれているとおりの表記で**書いてください（表記が違うと照合できず捨てられます）",
    "- 一覧に無い名前、説明的な言い回し、一般名詞は書かないでください",
    "- 関わった対象が無い場合は空のリストを返してください",
    "",
    "## 出力形式",
    "",
    "以下のJSON形式で出力してください。",
    "```json",
    EXTRACTION_FORMAT_EXAMPLE,
    "```",
    "",
    "JSONのみを出力してください。",
  );
  return parts.join("\n");
}

/** body: `_format_messages`. */
function formatMessages(messages: ChatMessage[]): string {
  return messages.flatMap((message) => {
    const content = message.content.trim();
    if (!content) return [];
    return [`[${formatTimestamp(epochSeconds(message.createdAt))}] [${message.role}]: ${content}`];
  }).join("\n\n");
}

function textField(item: Record<string, unknown>, key: string): string {
  const value = item[key];
  if (value === null || value === undefined) return "";
  if (typeof value !== "string") throw new ExtractionFailed(`entity extraction field '${key}' is not a string: ${typeof value}`);
  return value.trim();
}

/** body: `_parse_extraction_response`. A bare empty list is success; everything unreadable is a failure. */
export function parseExtractionResponse(response: string): ExtractedEntity[] {
  let text = response.trim();
  if (!text) throw new ExtractionFailed("entity extraction returned an empty response");
  const fenced = /```(?:json)?\s*\n?([\s\S]*?)\n?```/.exec(text);
  if (fenced) text = fenced[1]!.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ExtractionFailed(`entity extraction response is not valid JSON: ${String(error)}`);
  }
  const hasEntities = typeof parsed === "object" && parsed !== null && "entities" in parsed;
  const raw = Array.isArray(parsed) ? parsed : hasEntities ? (parsed as { entities: unknown }).entities : undefined;
  if (raw === undefined) throw new ExtractionFailed(`entity extraction response has no 'entities' field: ${text.slice(0, 200)}`);
  if (!Array.isArray(raw)) throw new ExtractionFailed(`entity extraction 'entities' is not a list: ${typeof raw}`);

  const entities: ExtractedEntity[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new ExtractionFailed(`entity extraction produced a non-object entity: ${String(item).slice(0, 120)}`);
    }
    const record = item as Record<string, unknown>;
    const name = textField(record, "name");
    if (!name) {
      console.warn("[SAIVerse Lite][entities] skipped an entity without a name", item);
      continue;
    }
    const category = (textField(record, "category") || DEFAULT_MEMOPEDIA_CATEGORY).toLowerCase();
    const summary = textField(record, "summary");
    const rawNotes = typeof record.notes === "string" ? [record.notes] : record.notes ?? [];
    if (!Array.isArray(rawNotes)) throw new ExtractionFailed(`entity extraction 'notes' is not a list: ${typeof rawNotes}`);
    const notes = rawNotes.map((note) => String(note).trim()).filter(Boolean);
    if (notes.length > 0 || summary) {
      entities.push({ name, category: isMemopediaCategory(category) ? category : DEFAULT_MEMOPEDIA_CATEGORY, summary, notes });
    }
  }
  return entities;
}

/** body: core.py `apply_entity_notes`, all in one transaction so a retry cannot leave half of it behind. */
async function reflectToMemopedia(
  repository: LiteRepository,
  personaId: string,
  entities: ExtractedEntity[],
  chronicleEntryId: string,
  sourceDate: string,
): Promise<void> {
  if (entities.length === 0) return;
  const pages = await repository.listPages(personaId);
  const fragments = await repository.listFragments(personaId);
  const writtenPages = new Map<string, PageRecord>();
  const writtenFragments: FragmentRecord[] = [];
  let nextShortId = await repository.nextPageShortId(personaId);
  const known = (title: string): PageRecord | undefined => findPageByTitle([...writtenPages.values(), ...pages], title);
  for (const entity of entities) {
    const current = known(entity.name);
    let page: PageRecord;
    if (current) {
      page = entity.summary && entity.summary !== current.summary ? { ...current, summary: entity.summary, updatedAt: epochSeconds(Date.now()) } : current;
    } else {
      page = memopediaPage(personaId, {
        parentId: `root_${entity.category}`,
        title: entity.name,
        summary: entity.summary,
        content: "",
        category: entity.category,
        shortId: nextShortId,
      });
      nextShortId += 1;
    }
    for (const note of entity.notes) {
      const exists = [...fragments, ...writtenFragments].some((fragment) => fragment.entityId === page.id
        && fragment.content === note && fragment.chronicleEntryId === chronicleEntryId);
      if (!exists) writtenFragments.push(fragmentRecord(personaId, { content: note, entityId: page.id, chronicleEntryId, sourceDate }));
    }
    writtenPages.set(page.id, { ...page, lastReferencedAt: epochSeconds(Date.now()) });
  }
  await repository.writePersonaRecords(personaId, { pages: [...writtenPages.values()], fragments: writtenFragments });
}

/** body: `make_batch_callback`'s callback. Throws when the extraction did not happen; "nothing to extract" is success. */
export async function extractAndReflect(
  repository: LiteRepository,
  personaId: string,
  llm: AuxiliaryLlm,
  messages: ChatMessage[],
  chronicleEntryId: string,
): Promise<void> {
  const conversation = formatMessages(messages);
  if (!conversation.trim()) return;
  const times = messages.map((message) => epochSeconds(message.createdAt));
  const chroniclePages = await repository.listPages(personaId, CATEGORY_CHRONICLE);
  const prompt = buildExtractionPrompt(
    conversation,
    episodeContextForTimerange(chroniclePages, Math.min(...times), EPISODE_CONTEXT_ENTRIES),
    formatPageList(await repository.listPages(personaId)),
  );
  let response: string;
  try {
    response = (await llm.provider.complete(auxiliaryRequest(llm, prompt))).text;
  } catch (error) {
    throw new ExtractionFailed(`entity extraction LLM call failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  await reflectToMemopedia(repository, personaId, parseExtractionResponse(response), chronicleEntryId, formatDate(Math.max(...times)));
}

/** body: `record_extraction_failure`. */
export async function recordExtractionFailure(repository: LiteRepository, personaId: string, entryId: string): Promise<void> {
  await repository.updateSession(personaId, (session) => {
    const backlog = session.extractionBacklog ?? [];
    const current = backlog.find((item) => item.entryId === entryId);
    return {
      ...session,
      extractionBacklog: current
        ? backlog.map((item) => (item === current ? { ...item, attempts: item.attempts + 1 } : item))
        : [...backlog, { entryId, attempts: 1 }],
    };
  });
}

async function setBacklogItem(repository: LiteRepository, personaId: string, entryId: string, next: ExtractionBacklogItem | null): Promise<void> {
  await repository.updateSession(personaId, (session) => ({
    ...session,
    extractionBacklog: (session.extractionBacklog ?? []).flatMap((item) => (item.entryId !== entryId ? [item] : next ? [next] : [])),
  }));
}

/** Takes an entry off the backlog `compileFold` put it on. */
export async function finishExtraction(repository: LiteRepository, personaId: string, entryId: string): Promise<void> {
  await setBacklogItem(repository, personaId, entryId, null);
}

/**
 * body: `retry_extraction_backlog`. The attempt is counted before the LLM call, so a
 * run killed mid-way still uses one up. A partly missing source stays in the backlog:
 * extracting from the rest would look like a recovery and lose the missing part.
 */
export async function retryExtractionBacklog(repository: LiteRepository, personaId: string, llm: AuxiliaryLlm): Promise<void> {
  const backlog = (await repository.getSession(personaId))?.extractionBacklog ?? [];
  for (const item of backlog) {
    if (item.attempts > MAX_EXTRACTION_RETRIES) {
      console.warn("[SAIVerse Lite][entities] extraction retries exhausted; the item stays", item);
      continue;
    }
    const attempted = { ...item, attempts: item.attempts + 1 };
    await setBacklogItem(repository, personaId, item.entryId, attempted);
    const page = await repository.getPage(personaId, item.entryId);
    const entry = page ? chronicleEntry(page) : null;
    const found = entry ? await Promise.all(entry.sourceIds.map((id) => repository.getMessage(id))) : [];
    const messages = found.filter((message): message is ChatMessage => message !== undefined);
    if (messages.length === 0) {
      await finishExtraction(repository, personaId, item.entryId);
      continue;
    }
    if (messages.length < found.length) {
      console.error("[SAIVerse Lite][entities] source rows of a backlog item are gone; not recovering from the rest", item);
      continue;
    }
    try {
      await extractAndReflect(repository, personaId, llm, messages, item.entryId);
      await finishExtraction(repository, personaId, item.entryId);
    } catch (error) {
      console.error("[SAIVerse Lite][entities] backlog retry failed", { entryId: item.entryId, error });
    }
  }
}
