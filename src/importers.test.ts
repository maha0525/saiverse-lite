import { describe, expect, it } from "vitest";
import { ChatGptExportAdapter, ClaudeExportAdapter, UnverifiedClaudeSchemaError } from "./importers";

describe("official export adapters", () => {
  it("uses the active ChatGPT branch and skips hidden messages", async () => {
    const payload = [{
      id: "conv",
      title: "branch",
      current_node: "assistant_b",
      mapping: {
        root: { parent: null, message: null },
        user: { parent: "root", message: { author: { role: "user" }, content: { content_type: "text", parts: ["hello"] }, create_time: 10 } },
        assistant_a: { parent: "user", message: { author: { role: "assistant" }, content: { content_type: "text", parts: ["unused"] }, create_time: 11 } },
        assistant_b: { parent: "user", message: { author: { role: "assistant" }, content: { content_type: "text", parts: ["chosen"] }, create_time: 12 } },
        hidden: { parent: "assistant_b", message: { author: { role: "assistant" }, content: { content_type: "text", parts: ["hidden"] }, metadata: { is_visually_hidden_from_conversation: true }, create_time: 13 } },
      },
    }];
    const file = new File([JSON.stringify(payload)], "conversations.json", { type: "application/json" });
    const conversations = await new ChatGptExportAdapter().parse(file);
    expect(conversations[0]?.messages.map((message) => message.content)).toEqual(["hello", "chosen"]);
  });

  it("does not guess the Claude schema", async () => {
    const file = new File(["[]"], "conversations.json", { type: "application/json" });
    await expect(new ClaudeExportAdapter().parse(file)).rejects.toBeInstanceOf(UnverifiedClaudeSchemaError);
  });
});
