import type { ProviderConfig, ToolCall, ToolId } from "../domain";
import type { RetryNotice } from "./retry";

export interface JsonSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolDefinition {
  id: ToolId;
  description: string;
  inputSchema: JsonSchema;
}

export interface ProviderMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  toolCallId: string | null;
  toolName: ToolId | null;
  toolCalls: ToolCall[];
  providerState?: Record<string, unknown>;
}

export interface ProviderRequest {
  model: string;
  systemPrompt: string;
  /** The Chronicle message, sent as one user turn ahead of the conversation. */
  memoryContext: string;
  messages: ProviderMessage[];
  tools: ToolDefinition[];
  toolChoice: "auto" | "none";
  signal?: AbortSignal;
  /** Called while the provider waits out a retryable HTTP error. */
  onRetry?: RetryNotice;
}

/** One non-streaming call. No tools: the Metabolism steps never offer any. */
export interface CompletionRequest {
  model: string;
  /** Blank when the call carries no head (Chronicle and entity extraction prompts). */
  systemPrompt: string;
  memoryContext: string;
  messages: ProviderMessage[];
  /** Plain JSON Schema. Providers that require `additionalProperties: false` add it themselves. */
  responseSchema?: JsonSchema;
  maxOutputTokens?: number;
  signal?: AbortSignal;
  onRetry?: RetryNotice;
}

export interface CompletionResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

/** OpenAI strict mode and Anthropic JSON outputs both reject an object without `additionalProperties: false`. */
export function closeJsonSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(closeJsonSchema);
  if (typeof schema !== "object" || schema === null) return schema;
  const node = { ...(schema as Record<string, unknown>) };
  if (typeof node.properties === "object" && node.properties !== null) {
    node.properties = Object.fromEntries(
      Object.entries(node.properties as Record<string, unknown>).map(([name, sub]) => [name, closeJsonSchema(sub)]),
    );
  }
  if (node.items !== undefined) node.items = closeJsonSchema(node.items);
  if (node.type === "object") node.additionalProperties = false;
  return node;
}

export type ProviderEvent =
  | { type: "text"; text: string }
  | { type: "tool-call"; call: ToolCall }
  | { type: "provider-state"; state: Record<string, unknown> }
  | { type: "usage"; inputTokens: number; outputTokens: number; cachedTokens: number };

export interface ImageGenerationResult {
  dataUrl: string;
  revisedPrompt: string | null;
}

export interface LlmProvider {
  readonly config: ProviderConfig;
  /** False skips the sluice: it cannot run without a schema-constrained reply. */
  readonly supportsStructuredOutput: boolean;
  stream(request: ProviderRequest): AsyncGenerator<ProviderEvent>;
  complete(request: CompletionRequest): Promise<CompletionResult>;
  generateImage(prompt: string, signal?: AbortSignal, onRetry?: RetryNotice): Promise<ImageGenerationResult>;
}

export class ProviderHttpError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
    readonly responseBody: string,
    /**
     * The model actually called. A persona carries its own model that overrides
     * the provider's, so the failing model is not always the one the user last
     * typed into settings - without naming it here, that mismatch is invisible.
     */
    readonly model: string | null = null,
  ) {
    super(`${provider} API error (${status})${model ? ` [model: ${model}]` : ""}: ${responseBody.slice(0, 500)}`);
    this.name = "ProviderHttpError";
  }
}

/**
 * An OpenAI compatible server turned down `response_format`. Servers word this differently and
 * many take only part of the schema, so the status decides: not a failure, a thing it cannot do.
 */
export class StructuredOutputRefusedError extends Error {
  constructor(override readonly cause: ProviderHttpError) {
    super(cause.message);
    this.name = "StructuredOutputRefusedError";
  }
}

export async function assertOk(response: Response, provider: string, model?: string): Promise<void> {
  if (response.ok) return;
  const body = await response.text();
  console.error(`[SAIVerse Lite][${provider}] HTTP error`, { status: response.status, model, body: body.slice(0, 1000) });
  throw new ProviderHttpError(provider, response.status, body, model ?? null);
}
