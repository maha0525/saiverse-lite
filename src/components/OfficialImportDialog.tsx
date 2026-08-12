import { useMemo, useState } from "react";
import { X } from "lucide-react";
import type { Persona, ProviderConfig } from "../domain";
import type { ImportedConversation } from "../importers";
import { buildPersonaPrompt, PERSONA_TEMPLATES } from "../onboarding";

export type ConversationImportTarget =
  | { kind: "existing"; personaId: string }
  | {
      kind: "new";
      persona: {
        name: string;
        description: string;
        systemPrompt: string;
        providerId: string;
        model: string;
      };
    };

interface OfficialImportDialogProps {
  conversations: ImportedConversation[];
  personas: Persona[];
  providers: ProviderConfig[];
  defaultPersonaId: string;
  busy: boolean;
  onConfirm(target: ConversationImportTarget, conversations: ImportedConversation[]): Promise<boolean>;
  onClose(): void;
}

function conversationDate(conversation: ImportedConversation): string {
  const value = conversation.updatedAt ?? conversation.createdAt;
  return value === null ? "日時不明" : new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium" }).format(value);
}

export function OfficialImportDialog(props: OfficialImportDialogProps) {
  const defaultPersona = props.personas.find((persona) => persona.id === props.defaultPersonaId);
  const firstProvider = props.providers.find((provider) => provider.id === defaultPersona?.providerId) ?? props.providers[0];
  const firstTemplate = PERSONA_TEMPLATES[0]!;
  const [targetValue, setTargetValue] = useState(props.defaultPersonaId);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [query, setQuery] = useState("");
  const [templateId, setTemplateId] = useState(firstTemplate.id);
  const [newPersona, setNewPersona] = useState({
    name: "",
    description: firstTemplate.description,
    systemPrompt: buildPersonaPrompt("", firstTemplate),
    providerId: firstProvider?.id ?? "provider_mock",
    model: defaultPersona?.model ?? firstProvider?.defaultModel ?? "mock-friendly",
  });
  const selectedConversations = useMemo(
    () => props.conversations.filter((conversation) => selectedIds.has(conversation.id)),
    [props.conversations, selectedIds],
  );
  const visibleConversations = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("ja");
    return normalized
      ? props.conversations.filter((conversation) => conversation.title.toLocaleLowerCase("ja").includes(normalized))
      : props.conversations;
  }, [props.conversations, query]);
  const isNew = targetValue === "__new__";

  const toggleConversation = (id: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const confirm = async () => {
    const target: ConversationImportTarget = isNew
      ? { kind: "new", persona: { ...newPersona, name: newPersona.name.trim(), description: newPersona.description.trim(), systemPrompt: newPersona.systemPrompt.trim() } }
      : { kind: "existing", personaId: targetValue };
    if (await props.onConfirm(target, selectedConversations)) props.onClose();
  };

  return (
    <div className="modal-overlay" role="presentation">
      <section className="modal-panel import-dialog" role="dialog" aria-modal="true" aria-labelledby="import-dialog-title">
        <div className="modal-head">
          <div><span className="eyebrow">CHATGPT IMPORT</span><h2 id="import-dialog-title">連れてくる会話とパートナーを選ぶ</h2></div>
          <button type="button" className="modal-close" onClick={props.onClose} aria-label="閉じる" disabled={props.busy}><X size={18} /></button>
        </div>

        <label className="field"><span>取り込み先のパートナー</span>
          <select value={targetValue} onChange={(event) => setTargetValue(event.target.value)} disabled={props.busy}>
            {props.personas.map((persona) => <option key={persona.id} value={persona.id}>{persona.name}</option>)}
            <option value="__new__">＋ 新しいパートナーを作る</option>
          </select>
        </label>

        {isNew && <div className="import-new-persona">
          <label className="field"><span>新しいパートナーの名前</span><input value={newPersona.name} onChange={(event) => {
            const template = PERSONA_TEMPLATES.find((item) => item.id === templateId);
            setNewPersona((current) => ({ ...current, name: event.target.value, systemPrompt: template ? buildPersonaPrompt(event.target.value, template) : current.systemPrompt }));
          }} placeholder="例: ソラ" /></label>
          <div className="field"><span>性格のプリセット</span><div className="wizard-cards small persona-template-cards">
            {PERSONA_TEMPLATES.map((template) => <button type="button" key={template.id} className={templateId === template.id ? "choice-card selected" : "choice-card"} onClick={() => {
              const previous = PERSONA_TEMPLATES.find((item) => item.id === templateId);
              setTemplateId(template.id);
              setNewPersona((current) => ({
                ...current,
                description: !current.description || current.description === previous?.description ? template.description : current.description,
                systemPrompt: buildPersonaPrompt(current.name, template),
              }));
            }}><strong>{template.label}</strong><p>{template.description}</p></button>)}
          </div></div>
          <label className="field"><span>紹介</span><input value={newPersona.description} onChange={(event) => setNewPersona({ ...newPersona, description: event.target.value })} /></label>
          <label className="field"><span>人格の定義</span><textarea rows={6} value={newPersona.systemPrompt} onChange={(event) => setNewPersona({ ...newPersona, systemPrompt: event.target.value })} /></label>
          <div className="field-grid">
            <label className="field"><span>プロバイダ</span><select value={newPersona.providerId} onChange={(event) => {
              const provider = props.providers.find((item) => item.id === event.target.value);
              setNewPersona({ ...newPersona, providerId: event.target.value, model: provider?.defaultModel ?? newPersona.model });
            }}>{props.providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}</option>)}</select></label>
            <label className="field"><span>モデルID</span><input value={newPersona.model} onChange={(event) => setNewPersona({ ...newPersona, model: event.target.value })} /></label>
          </div>
        </div>}

        <div className="import-conversation-heading">
          <div><strong>取り込む会話</strong><small>{selectedConversations.length} / {props.conversations.length}件を選択中</small></div>
          <div><button type="button" className="text-button" onClick={() => setSelectedIds(new Set(props.conversations.map((conversation) => conversation.id)))}>すべて選ぶ</button><button type="button" className="text-button" onClick={() => setSelectedIds(new Set())}>すべて外す</button></div>
        </div>
        <div className="import-conversation-filter">
          <label className="field"><span>会話タイトルを検索</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="例: ソラ" /></label>
          <button type="button" className="button secondary" disabled={visibleConversations.length === 0} onClick={() => setSelectedIds((current) => new Set([...current, ...visibleConversations.map((conversation) => conversation.id)]))}>表示中を選ぶ</button>
        </div>
        <div className="import-conversation-list">
          {visibleConversations.map((conversation) => (
            <label key={conversation.id} className="import-conversation-item">
              <input type="checkbox" checked={selectedIds.has(conversation.id)} onChange={() => toggleConversation(conversation.id)} disabled={props.busy} />
              <span><strong>{conversation.title}</strong><small>{conversationDate(conversation)}・{conversation.messages.filter((message) => message.role === "user" || message.role === "assistant").length}発言</small></span>
            </label>
          ))}
          {visibleConversations.length === 0 && <p className="field-help">一致する会話がありません。</p>}
        </div>
        <div className="form-actions import-dialog-actions">
          <button type="button" className="button" onClick={() => void confirm()} disabled={props.busy || selectedConversations.length === 0 || (isNew && (!newPersona.name.trim() || !newPersona.systemPrompt.trim() || !newPersona.model.trim()))}>{props.busy ? "取り込み中…" : `${selectedConversations.length}件を取り込む`}</button>
          <button type="button" className="button secondary" onClick={props.onClose} disabled={props.busy}>キャンセル</button>
        </div>
      </section>
    </div>
  );
}
