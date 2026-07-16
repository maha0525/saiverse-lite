import type { ProviderConfig, ToolCall, ToolId } from "../domain";

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
  generateImage(prompt: string, signal?: AbortSignal): Promise<ImageGenerationResult>;
}

export class ProviderHttpError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
    readonly responseBody: string,
  ) {
    super(`${provider} API error (${status}): ${responseBody.slice(0, 500)}`);
    this.name = "ProviderHttpError";
  }
}

export async function assertOk(response: Response, provider: string): Promise<void> {
  if (response.ok) return;
  const body = await response.text();
  console.error(`[SAIVerse Lite][${provider}] HTTP error`, { status: response.status, body: body.slice(0, 1000) });
  throw new ProviderHttpError(provider, response.status, body);
}
