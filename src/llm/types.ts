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
  memoryContext: string;
  messages: ProviderMessage[];
  tools: ToolDefinition[];
  toolChoice: "auto" | "none";
  signal?: AbortSignal;
  /** Called while the provider waits out a retryable HTTP error. */
  onRetry?: RetryNotice;
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
  stream(request: ProviderRequest): AsyncGenerator<ProviderEvent>;
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

export async function assertOk(response: Response, provider: string, model?: string): Promise<void> {
  if (response.ok) return;
  const body = await response.text();
  console.error(`[SAIVerse Lite][${provider}] HTTP error`, { status: response.status, model, body: body.slice(0, 1000) });
  throw new ProviderHttpError(provider, response.status, body, model ?? null);
}
