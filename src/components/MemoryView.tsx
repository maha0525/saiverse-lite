import { X } from "lucide-react";
import { useCallback, useDeferredValue, useEffect, useMemo, useState, type FormEvent } from "react";
import type { FragmentRecord, PageRecord, Persona } from "../domain";
import { coreBudgetNote, replaceCoreMemory, writePage } from "../memory/atlas";
import { categoryTitle, matchesQuery, memopediaCategories, memopediaCount, memopediaTree, searchMemopedia, updateMemopediaPage } from "../memory/browse";
import { chronicleEntries, formatTimestamp, type ChronicleEntry } from "../memory/entries";
import { coreMemoryId } from "../memory/head";
import { composePageBody, findPageByTitle, isMemopediaPage } from "../memory/memopedia";
import { loadDraft, saveDraft } from "../onboarding";
import { epochSeconds, liveCoreMemories, softDeleteCoreMemory } from "../pageRecords";
import type { LiteRepository } from "../storage/repository";

type MemoryTab = "core" | "memopedia" | "chronicle";

const PAGE_LIST_STEP = 100;
const CHRONICLE_LIST_STEP = 50;
/** Set once the note below has been on the screen, so it appears a single time on this device. */
const CORE_NOTE_SHOWN_KEY = "memory.coreNoteShown";

interface MemoryViewProps {
  persona: Persona;
  repository: LiteRepository;
  /** Changes when a background run may have written pages. */
  revision: number;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function updatedTime(seconds: number): string {
  return new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short" }).format(seconds * 1000);
}

interface CoreTabProps {
  persona: Persona;
  repository: LiteRepository;
  pages: PageRecord[];
  onChanged(): Promise<void>;
  onError(message: string): void;
}

function CoreMemoryCard({ page, onSave, onDelete }: { page: PageRecord; onSave(page: PageRecord, content: string): Promise<boolean>; onDelete(page: PageRecord): Promise<void> }) {
  const [draft, setDraft] = useState<string | null>(null);
  const scene = page.metadata.kind === "scene";
  const save = async () => {
    const text = draft?.trim();
    if (!text) return;
    if (text === page.content || await onSave(page, text)) setDraft(null);
  };
  return (
    <article className="memory-card">
      <div className="memory-card-head"><span className="memory-kind">{scene ? "会話の記憶" : "記憶"}</span><time>{updatedTime(page.updatedAt)}</time></div>
      {draft === null
        ? <p>{page.content}</p>
        : <textarea className="memory-card-editor" rows={5} value={draft} onChange={(event) => setDraft(event.target.value)} aria-label="記憶の内容" />}
      <div className="memory-actions">
        {draft === null
          ? <>
              {!scene && <button className="text-button" onClick={() => setDraft(page.content)}>訂正</button>}
              <button className="text-button danger" onClick={() => void onDelete(page)}>削除</button>
            </>
          : <>
              <button className="text-button" onClick={() => void save()} disabled={!draft.trim()}>保存</button>
              <button className="text-button" onClick={() => setDraft(null)}>やめる</button>
            </>}
      </div>
    </article>
  );
}

function CoreTab({ persona, repository, pages, onChanged, onError }: CoreTabProps) {
  const [draft, setDraft] = useState("");
  const memories = useMemo(() => liveCoreMemories(pages), [pages]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;
    try {
      await repository.addCoreMemories(persona.id, [{ content: text }]);
      setDraft("");
      await onChanged();
    } catch (error) {
      console.error("[SAIVerse Lite][memory] core memory could not be added", error);
      onError(`記憶を加えられませんでした: ${errorText(error)}`);
    }
  };
  const save = async (page: PageRecord, content: string): Promise<boolean> => {
    try {
      const result = await replaceCoreMemory(repository, persona.id, coreMemoryId(page), content);
      if (result !== "replaced") {
        onError(result === "scene" ? "会話の記憶は書き換えられません。" : "この記憶は見つかりませんでした。画面を開き直してください。");
        return false;
      }
      await onChanged();
      return true;
    } catch (error) {
      console.error("[SAIVerse Lite][memory] core memory could not be saved", error);
      onError(`記憶を保存できませんでした: ${errorText(error)}`);
      return false;
    }
  };
  const remove = async (page: PageRecord) => {
    if (!window.confirm("この記憶を削除しますか？")) return;
    try {
      await repository.putPage(softDeleteCoreMemory(page, epochSeconds(Date.now())));
      await onChanged();
    } catch (error) {
      console.error("[SAIVerse Lite][memory] core memory could not be deleted", error);
      onError(`記憶を削除できませんでした: ${errorText(error)}`);
    }
  };
  return (
    <>
      <form className="panel memory-compose" onSubmit={(event) => void submit(event)}>
        <label className="field"><span>覚えていてほしいこと</span><textarea value={draft} onChange={(event) => setDraft(event.target.value)} rows={3} placeholder="好み、約束、大切な出来事…" /></label>
        <button className="button" disabled={!draft.trim()}>記憶に加える</button>
      </form>
      <p className="field-help memory-budget">{coreBudgetNote(pages)}</p>
      <div className="memory-grid">
        {memories.map((page) => <CoreMemoryCard key={page.id} page={page} onSave={save} onDelete={remove} />)}
        {memories.length === 0 && <div className="empty-state compact-empty"><h2>まだ記憶はありません</h2><p>覚えていてほしいことを手書きで追加できます。</p></div>}
      </div>
    </>
  );
}

interface MemopediaTabProps {
  persona: Persona;
  repository: LiteRepository;
  pages: PageRecord[];
  onChanged(): Promise<void>;
  onError(message: string): void;
}

interface PageDraft {
  title: string;
  summary: string;
  content: string;
}

function PageForm({ draft, showSummary, onChange, onSave, onCancel, saveLabel }: { draft: PageDraft; showSummary: boolean; onChange(draft: PageDraft): void; onSave(): void; onCancel(): void; saveLabel: string }) {
  return (
    <form className="memory-page-form" onSubmit={(event) => { event.preventDefault(); onSave(); }}>
      <label className="field"><span>題</span><input value={draft.title} onChange={(event) => onChange({ ...draft, title: event.target.value })} required /></label>
      {showSummary && <label className="field"><span>概要</span><input value={draft.summary} onChange={(event) => onChange({ ...draft, summary: event.target.value })} /></label>}
      <label className="field"><span>本文</span><textarea rows={12} value={draft.content} onChange={(event) => onChange({ ...draft, content: event.target.value })} /></label>
      <div className="form-actions"><button className="button" type="submit" disabled={!draft.title.trim()}>{saveLabel}</button><button className="button secondary" type="button" onClick={onCancel}>やめる</button></div>
    </form>
  );
}

function MemopediaTab({ persona, repository, pages, onChanged, onError }: MemopediaTabProps) {
  const categories = useMemo(() => memopediaCategories(pages), [pages]);
  const [category, setCategory] = useState(() => categories.find((item) => memopediaCount(pages, item) > 0) ?? categories[0] ?? "");
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query.trim());
  const [shown, setShown] = useState(PAGE_LIST_STEP);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [fragments, setFragments] = useState<FragmentRecord[]>([]);
  const [editing, setEditing] = useState<PageDraft | null>(null);
  const [creating, setCreating] = useState<PageDraft | null>(null);

  const rows = useMemo(
    () => (deferredQuery ? searchMemopedia(pages, deferredQuery) : memopediaTree(pages, category)),
    [pages, category, deferredQuery],
  );
  const selected = useMemo(() => pages.find((page) => page.id === selectedId && isMemopediaPage(page)) ?? null, [pages, selectedId]);

  useEffect(() => setShown(PAGE_LIST_STEP), [category, deferredQuery]);
  useEffect(() => {
    setFragments([]);
    if (!selectedId) return;
    let cancelled = false;
    void repository.listFragments(persona.id, selectedId).then((items) => {
      if (!cancelled) setFragments(items);
    }).catch((error: unknown) => {
      console.error("[SAIVerse Lite][memory] fragments could not be read", error);
      if (!cancelled) onError(`記憶の断片を読めませんでした: ${errorText(error)}`);
    });
    return () => { cancelled = true; };
  }, [repository, persona.id, selectedId, onError]);

  const open = (id: string) => {
    setSelectedId(id);
    setEditing(null);
    setCreating(null);
  };
  const saveEdit = async () => {
    if (!selected || !editing) return;
    const edit = { title: editing.title.trim(), summary: editing.summary.trim(), content: editing.content };
    try {
      const result = await updateMemopediaPage(repository, persona.id, selected.id, edit);
      if (result === "title-taken") return onError("同じ題のページがすでにあります。別の題にしてください。");
      if (result === "missing") return onError("このページは見つかりませんでした。画面を開き直してください。");
      setEditing(null);
      await onChanged();
    } catch (error) {
      console.error("[SAIVerse Lite][memory] page could not be saved", error);
      onError(`ページを保存できませんでした: ${errorText(error)}`);
    }
  };
  const saveNew = async () => {
    if (!creating) return;
    const title = creating.title.trim();
    if (!creating.content.trim()) return onError("本文を書いてください。");
    try {
      if (findPageByTitle(await repository.listPages(persona.id), title)) return onError("同じ題のページがすでにあります。別の題にしてください。");
      await writePage(repository, persona.id, { title, category, content: creating.content });
      const written = findPageByTitle(await repository.listPages(persona.id), title);
      if (!written) return onError("ページを作れませんでした。");
      setCreating(null);
      setSelectedId(written.id);
      await onChanged();
    } catch (error) {
      console.error("[SAIVerse Lite][memory] page could not be created", error);
      onError(`ページを作れませんでした: ${errorText(error)}`);
    }
  };

  return (
    <div className="memory-browser">
      <aside className="panel memory-side">
        <label className="field"><span>ページを探す</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="題や本文の言葉" /></label>
        {!query.trim() && <div className="provider-tabs">
          {categories.map((item) => <button type="button" key={item} className={item === category ? "chip selected" : "chip"} onClick={() => { setCategory(item); setCreating(null); }}>{categoryTitle(pages, item)} {memopediaCount(pages, item)}</button>)}
        </div>}
        <div className="memory-page-list">
          {rows.slice(0, shown).map(({ page, depth }) => (
            <button type="button" key={page.id} className={page.id === selectedId ? "memory-page-row selected" : "memory-page-row"} style={{ paddingLeft: 10 + Math.min(depth, 4) * 16 }} onClick={() => open(page.id)}>{page.title}</button>
          ))}
          {rows.length === 0 && <p className="field-help">{query.trim() ? "一致するページがありません。" : "このカテゴリにページはまだありません。"}</p>}
          {rows.length > shown && <button type="button" className="text-button" onClick={() => setShown((value) => value + PAGE_LIST_STEP)}>続きを表示（残り {rows.length - shown}件）</button>}
        </div>
        {!query.trim() && <button type="button" className="button secondary" onClick={() => { setSelectedId(null); setEditing(null); setCreating({ title: "", summary: "", content: "" }); }}>{categoryTitle(pages, category)}にページを作る</button>}
      </aside>
      <div className="panel memory-detail">
        {creating
          ? <><h2>{categoryTitle(pages, category)}の新しいページ</h2><PageForm draft={creating} showSummary={false} onChange={setCreating} onSave={() => void saveNew()} onCancel={() => setCreating(null)} saveLabel="作る" /></>
          : selected && editing
            ? <><h2>{selected.title}を直す</h2><PageForm draft={editing} showSummary onChange={setEditing} onSave={() => void saveEdit()} onCancel={() => setEditing(null)} saveLabel="保存" /></>
            : selected
              ? <>
                  <div className="memory-detail-head"><h2>{selected.title}</h2><button type="button" className="text-button" onClick={() => setEditing({ title: selected.title, summary: selected.summary, content: selected.content })}>直す</button></div>
                  <p className="field-help">{categoryTitle(pages, selected.category)}・{updatedTime(selected.updatedAt)}{selected.shortId !== null && `・m:${selected.shortId}`}</p>
                  {selected.summary && <p className="memory-summary">{selected.summary}</p>}
                  <div className="memory-body">{composePageBody(selected, fragments) || <span className="muted">本文はまだありません。</span>}</div>
                </>
              : <p className="field-help">一覧からページを選ぶと、ここに本文が出ます。</p>}
      </div>
    </div>
  );
}

function chronicleTime(entry: ChronicleEntry): number {
  return entry.endTime ?? entry.startTime ?? entry.createdAt;
}

function ChronicleTab({ pages }: { pages: PageRecord[] }) {
  const entries = useMemo(() => chronicleEntries(pages).sort((a, b) => chronicleTime(b) - chronicleTime(a)), [pages]);
  const levels = useMemo(() => [...new Set(entries.map((entry) => entry.level))].sort((a, b) => a - b), [entries]);
  const [level, setLevel] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query.trim());
  const [shown, setShown] = useState(CHRONICLE_LIST_STEP);
  const visible = useMemo(
    () => entries.filter((entry) => (level === null || entry.level === level) && (!deferredQuery || matchesQuery(entry.content, deferredQuery))),
    [entries, level, deferredQuery],
  );
  useEffect(() => setShown(CHRONICLE_LIST_STEP), [level, deferredQuery]);
  if (entries.length === 0) return <div className="empty-state compact-empty"><h2>あらすじはまだありません</h2><p>会話が長くなると、記憶の整理であらすじが書かれます。</p></div>;
  return (
    <>
      <div className="memory-toolbar">
        <label className="field"><span>あらすじを探す</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="本文の言葉" /></label>
        {levels.length > 1 && <div className="provider-tabs">
          <button type="button" className={level === null ? "chip selected" : "chip"} onClick={() => setLevel(null)}>すべて</button>
          {levels.map((item) => <button type="button" key={item} className={item === level ? "chip selected" : "chip"} onClick={() => setLevel(item)}>レベル{item}</button>)}
        </div>}
      </div>
      <div className="memory-chronicle">
        {visible.slice(0, shown).map((entry) => (
          <article className="memory-card" key={entry.id}>
            <div className="memory-card-head"><span className="memory-kind">レベル{entry.level}{entry.shortId !== null && `・ch:${entry.shortId}`}</span><time>{formatTimestamp(entry.startTime)} 〜 {formatTimestamp(entry.endTime)}</time></div>
            <p>{entry.content}</p>
          </article>
        ))}
        {visible.length === 0 && <p className="field-help">一致するあらすじがありません。</p>}
        {visible.length > shown && <button type="button" className="text-button" onClick={() => setShown((value) => value + CHRONICLE_LIST_STEP)}>続きを表示（残り {visible.length - shown}件）</button>}
      </div>
    </>
  );
}

export function MemoryView({ persona, repository, revision }: MemoryViewProps) {
  const [tab, setTab] = useState<MemoryTab>("core");
  const [pages, setPages] = useState<PageRecord[] | null>(null);
  const [error, setError] = useState("");
  const [coreNote, setCoreNote] = useState(false);

  const load = useCallback(async () => {
    try {
      setPages(await repository.listPages(persona.id));
    } catch (failure) {
      console.error("[SAIVerse Lite][memory] pages could not be read", failure);
      setError(`記憶を読み込めませんでした: ${errorText(failure)}`);
    }
  }, [repository, persona.id]);
  useEffect(() => { void load(); }, [load, revision]);

  const onError = useCallback((message: string) => setError(message), []);
  const reload = useCallback(async () => { setError(""); await load(); }, [load]);
  const coreChanged = useCallback(async () => {
    await reload();
    if (loadDraft(CORE_NOTE_SHOWN_KEY)) return;
    saveDraft(CORE_NOTE_SHOWN_KEY, "1");
    setCoreNote(true);
  }, [reload]);

  const counts = useMemo(() => ({
    core: liveCoreMemories(pages ?? []).length,
    memopedia: (pages ?? []).filter(isMemopediaPage).length,
    chronicle: chronicleEntries(pages ?? []).length,
  }), [pages]);
  const tabs: Array<{ id: MemoryTab; label: string; count: number }> = [
    { id: "core", label: "コア記憶", count: counts.core },
    { id: "memopedia", label: "Memopedia", count: counts.memopedia },
    { id: "chronicle", label: "Chronicle", count: counts.chronicle },
  ];

  return (
    <section className="view content-view" aria-labelledby="memory-title">
      <header className="view-header"><div><span className="eyebrow">MEMORY</span><h1 id="memory-title">{persona.name}の記憶</h1><p>保存した記憶を、ここで見て直せます。</p></div></header>
      <div className="provider-tabs memory-tabs">
        {tabs.map((item) => <button type="button" key={item.id} className={item.id === tab ? "chip selected" : "chip"} aria-pressed={item.id === tab} onClick={() => setTab(item.id)}>{item.label} {item.count}件</button>)}
      </div>
      {coreNote && <div className="notice memory-note" role="status"><span>変更は次の記憶整理から会話に反映されます。</span><button type="button" className="notice-close" onClick={() => setCoreNote(false)} aria-label="閉じる"><X size={16} /></button></div>}
      {error && <div className="notice" role="alert">{error}</div>}
      {pages && tab === "core" && <CoreTab persona={persona} repository={repository} pages={pages} onChanged={coreChanged} onError={onError} />}
      {pages && tab === "memopedia" && <MemopediaTab persona={persona} repository={repository} pages={pages} onChanged={reload} onError={onError} />}
      {pages && tab === "chronicle" && <ChronicleTab pages={pages} />}
    </section>
  );
}
