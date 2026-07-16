import { useEffect, useState, type FormEvent } from "react";
import { newId, type Persona, type ProviderConfig, type ToolId } from "../domain";
import { loadDraft, saveDraft } from "../onboarding";

const NEW_FORM_DRAFT_KEY = "personaForm.new";

function restoreNewDraft(base: Persona): Persona {
  try {
    const raw = loadDraft(NEW_FORM_DRAFT_KEY);
    if (!raw) return base;
    const saved = JSON.parse(raw) as Partial<Pick<Persona, "name" | "description" | "systemPrompt">>;
    return { ...base, name: saved.name ?? "", description: saved.description ?? "", systemPrompt: saved.systemPrompt ?? "" };
  } catch {
    return base;
  }
}

interface PersonaViewProps {
  personas: Persona[];
  providers: ProviderConfig[];
  selectedId: string;
  onSelect(id: string): void;
  onSave(persona: Persona): Promise<void>;
  onDelete(id: string): Promise<void>;
}

function blankPersona(provider: ProviderConfig | undefined): Persona {
  const now = Date.now();
  return {
    id: newId("persona"),
    name: "",
    description: "",
    systemPrompt: "",
    avatarDataUrl: null,
    providerId: provider?.id ?? "provider_mock",
    model: provider?.defaultModel ?? "mock-friendly",
    toolIds: ["memory_recall", "image_generate"],
    createdAt: now,
    updatedAt: now,
  };
}

export function PersonaView({ personas, providers, selectedId, onSelect, onSave, onDelete }: PersonaViewProps) {
  const selected = personas.find((persona) => persona.id === selectedId);
  const [draft, setDraft] = useState<Persona>(() => selected ?? blankPersona(providers[0]));
  const [isNew, setIsNew] = useState(false);
  useEffect(() => {
    if (selected && !isNew) setDraft(structuredClone(selected));
  }, [selected, isNew]);

  // 書きかけの新規フォームを端末へ自動保存 (事故で閉じても消えない)
  useEffect(() => {
    if (!isNew) return;
    const timer = setTimeout(() => {
      const hasContent = draft.name.trim() || draft.description.trim() || draft.systemPrompt.trim();
      saveDraft(NEW_FORM_DRAFT_KEY, hasContent ? JSON.stringify({ name: draft.name, description: draft.description, systemPrompt: draft.systemPrompt }) : "");
    }, 400);
    return () => clearTimeout(timer);
  }, [isNew, draft.name, draft.description, draft.systemPrompt]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft.name.trim() || !draft.systemPrompt.trim()) return;
    const saved = { ...draft, name: draft.name.trim(), updatedAt: Date.now() };
    await onSave(saved);
    if (isNew) saveDraft(NEW_FORM_DRAFT_KEY, "");
    setIsNew(false);
    onSelect(saved.id);
  };
  const setTool = (tool: ToolId, checked: boolean) => {
    setDraft((current) => ({ ...current, toolIds: checked ? [...new Set([...current.toolIds, tool])] : current.toolIds.filter((id) => id !== tool) }));
  };
  const loadAvatar = (file: File | undefined) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setDraft((current) => ({ ...current, avatarDataUrl: typeof reader.result === "string" ? reader.result : null }));
    reader.readAsDataURL(file);
  };
  return (
    <section className="view content-view" aria-labelledby="persona-title">
      <header className="view-header persona-view-header"><div><span className="eyebrow">PERSONA</span><h1 id="persona-title">パートナー</h1><p>人格・話し方・使うモデルを、ひとりずつ固定します。</p></div><button className="button" onClick={() => { setDraft(restoreNewDraft(blankPersona(providers[0]))); setIsNew(true); }}>新しく迎える</button></header>
      <div className="split-layout">
        <aside className="card-list" aria-label="ペルソナ一覧">
          {personas.map((persona) => (
            <button key={persona.id} className={persona.id === selectedId && !isNew ? "persona-card selected" : "persona-card"} onClick={() => { setIsNew(false); onSelect(persona.id); }}>
              <span className="card-avatar">{persona.avatarDataUrl ? <img src={persona.avatarDataUrl} alt="" /> : persona.name.slice(0, 1)}</span>
              <span className="persona-card-copy"><strong>{persona.name}</strong><small>{persona.description || "説明はまだありません"}</small></span>
            </button>
          ))}
        </aside>
        <form className="panel form-panel" onSubmit={(event) => void submit(event)}>
          <div className="form-heading"><h2>{isNew ? "新しいパートナー" : `${draft.name}の定義`}</h2><span className="local-chip">端末内のみ</span></div>
          <div className="avatar-editor">
            <div className="large-avatar">{draft.avatarDataUrl ? <img src={draft.avatarDataUrl} alt="" /> : draft.name.slice(0, 1) || "?"}</div>
            <label className="button secondary file-button">アイコンを選ぶ<input type="file" accept="image/*" onChange={(event) => loadAvatar(event.target.files?.[0])} /></label>
            {draft.avatarDataUrl && <button type="button" className="text-button danger" onClick={() => setDraft((current) => ({ ...current, avatarDataUrl: null }))}>外す</button>}
          </div>
          <label className="field"><span>名前</span><input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} required /></label>
          <label className="field"><span>紹介</span><input value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} placeholder="どんな子か、短い紹介" /></label>
          <label className="field"><span>システムプロンプト（固定 head）</span><textarea rows={9} value={draft.systemPrompt} onChange={(event) => setDraft({ ...draft, systemPrompt: event.target.value })} required /></label>
          <div className="field-grid">
            <label className="field"><span>プロバイダ</span><select value={draft.providerId} onChange={(event) => {
              const provider = providers.find((item) => item.id === event.target.value);
              setDraft({ ...draft, providerId: event.target.value, model: provider?.defaultModel ?? draft.model });
            }}>{providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}</option>)}</select></label>
            <label className="field"><span>モデルID</span><input value={draft.model} onChange={(event) => setDraft({ ...draft, model: event.target.value })} required /></label>
          </div>
          <fieldset className="tool-field"><legend>固定ツールセット</legend>
            <label><input type="checkbox" checked={draft.toolIds.includes("memory_recall")} onChange={(event) => setTool("memory_recall", event.target.checked)} /> 記憶想起</label>
            <label><input type="checkbox" checked={draft.toolIds.includes("image_generate")} onChange={(event) => setTool("image_generate", event.target.checked)} /> 画像生成</label>
          </fieldset>
          <div className="form-actions"><button className="button" type="submit">保存する</button>{!isNew && personas.length > 1 && <button type="button" className="button danger-button" onClick={() => void onDelete(draft.id)}>この子を削除</button>}</div>
        </form>
      </div>
    </section>
  );
}
