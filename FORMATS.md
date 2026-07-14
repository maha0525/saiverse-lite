# SAIVerse Lite data formats

This file is the single source of truth for data that crosses the SAIVerse Lite boundary.
Application code must import the constants and serializers in `src/formats.ts`; do not
invent ad-hoc export shapes in UI code.

## Compatibility sources inspected

The contract was derived from the current SAIVerse implementation on 2026-07-15:

- `tools/utilities/chatgpt_importer.py`
- `api/routes/people/import_chatlog.py`
- `saiverse_memory/native_export.py`
- `api/routes/people/native_export_import.py`

The body repository was read only. Lite does not read or write `~/.saiverse`.

## 1. Persona definition: `saiverse_lite_persona_v1`

Persona export is UTF-8 JSON:

```json
{
  "format": "saiverse_lite_persona_v1",
  "exported_at": "2026-07-15T00:00:00.000Z",
  "persona": {
    "id": "persona_example",
    "name": "Example",
    "description": "...",
    "systemPrompt": "...",
    "avatarDataUrl": null,
    "providerId": "provider_mock",
    "model": "mock-friendly",
    "toolIds": ["memory_recall", "image_generate"],
    "createdAt": 0,
    "updatedAt": 0
  },
  "saiverse_blueprint": {
    "name": "Example",
    "description": "...",
    "system_prompt": "...",
    "entity_type": "ai"
  }
}
```

`saiverse_blueprint` is intentionally isomorphic to the existing SAIVerse
`BlueprintCreate` request, except that the destination `city_id` is not portable and must
be selected at import time. The body currently has a Blueprint API but no persona-file
import endpoint. Therefore this mapping is documented and tested in Lite, but end-to-end
persona file import into the body remains a body-side integration task. Lite does not
claim that missing importer as verified.

API keys are never part of persona definitions.

## 2. Conversation and memory: `saiverse_saimemory_v1`

Lite exports the exact top-level format accepted by the current body native importer:

```json
{
  "format": "saiverse_saimemory_v1",
  "exported_at": "2026-07-15T00:00:00.000Z",
  "persona_id": "persona_example",
  "threads": []
}
```

Each conversation becomes a native thread. Thread IDs are
`<persona-id>:<lite-thread-id>`. Messages preserve the body fields `id`, `role`,
`content`, `resource_id`, `created_at`, and `metadata`. Timestamps are Unix seconds,
matching `saiverse_memory/native_export.py`.

Lite adds namespaced metadata without replacing existing metadata:

- `lite_message_id`
- `lite_thread_id`
- `edited_at`
- `tool_call_id`
- `tool_name`
- tags `conversation` and `saiverse_lite`

Long-term memories are exported as messages in the synthetic thread
`<persona-id>:lite-memory`. Their metadata contains:

- tags `memory`, `summary` or `note`, and `saiverse_lite`
- `lite_memory_id`
- `lite_thread_id` (nullable for persona-wide notes)
- `source_message_ids`
- `updated_at`

This uses fields already preserved by the body native importer. The Lite round-trip test
asserts preservation of thread IDs, message IDs, content, roles, and memory entries.

## 3. Full backup: `saiverse_lite_backup_v1`

The full backup is a UTF-8 JSON snapshot of all Lite object stores:

```json
{
  "format": "saiverse_lite_backup_v1",
  "exported_at": "2026-07-15T00:00:00.000Z",
  "includes_api_keys": false,
  "data": {
    "personas": [],
    "threads": [],
    "messages": [],
    "memories": [],
    "providers": [],
    "settings": {}
  }
}
```

Provider records are included so models and compatible URLs survive migration, but every
`apiKey` is replaced with an empty string. Keys must be entered again on the destination
device. Restore replaces the entire local database after explicit confirmation.

## 4. Automatic summary pipeline

The pipeline is deterministic:

1. After an assistant turn is committed, count user and assistant messages newer than
   the latest summary's `sourceMessageIds`.
2. Trigger when that count reaches `settings.summaryEveryMessages` (default 12).
3. Ask the active provider for a concise factual summary with tools disabled.
4. Store one `MemoryEntry(kind="summary")` with every covered message ID.

Prompt assembly order is fixed:

1. persona system prompt (**fixed head**)
2. persona tool definitions (**fixed for the persona**)
3. injected memory block (summaries and user notes, deterministic newest-first budget)
4. recent conversation window (`recentContextMessages`, default 24)
5. current user input / tool result

The fixed system head and fixed tool set never depend on an individual turn. This keeps
provider prefix-cache structure stable. The memory block is intentionally after that
fixed head.

## 5. Official ChatGPT and Claude imports

Importers implement a source adapter interface. The ChatGPT adapter follows the body
parser's rules:

- read `conversations.json` and numbered `conversations-*.json` files from JSON or ZIP
- follow `current_node` through `parent` links to select the active branch
- ignore visually hidden messages
- accept text, multimodal text, code, and supported tool-result text
- preserve timestamps and conversation IDs

No Claude official export sample exists in the repository available to this implementation.
The Claude adapter boundary therefore exists but intentionally rejects data with a clear
“schema verification required” error. It must not guess that a same-named
`conversations.json` is ChatGPT-compatible. See `HANDOFF.md`.

## 6. Versioning rules

- Readers reject unknown `format` values; they do not silently coerce them.
- Additive optional fields may be introduced without changing the format name.
- Removing or changing field meaning requires a new format version and a migration.
- A format change must update `src/formats.ts`, this document, and round-trip tests in
  the same change.
