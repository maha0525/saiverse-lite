import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createChatMessage, createDefaultPersona, type AppSettings, type ChatMessage } from "../domain";
import { MessageBubble, MessageEditor } from "./ChatView";

function renderedBubble(role: ChatMessage["role"]): string {
  const persona = createDefaultPersona(1);
  const unused = () => Promise.resolve();
  return renderToStaticMarkup(createElement(MessageBubble, {
    message: createChatMessage({ id: "message_1", threadId: "thread", personaId: persona.id, role, content: "こんにちは", createdAt: 1_793_000_000_000, seq: 1 }),
    persona, settings: { userName: "まはー" } as AppSettings, disabled: false, replyDisabled: false,
    onEdit: () => Promise.resolve(true), onReplyAgain: unused, onDelete: unused, onReadImage: () => Promise.resolve(null),
  }));
}

function renderedEditor(content: string): string {
  return renderToStaticMarkup(createElement(MessageEditor, {
    content, disabled: false, onSave: () => Promise.resolve(true), onCancel: () => undefined,
  }));
}

describe("a message", () => {
  it("offers to reply again from a user row, apart from editing it", () => {
    const html = renderedBubble("user");
    expect(html).toContain("編集");
    expect(html).toContain("ここから話し直す");
  });

  it("has nothing to reply again from on a persona's row", () => {
    const html = renderedBubble("assistant");
    expect(html).toContain("編集");
    expect(html).not.toContain("ここから話し直す");
  });
});

describe("the message editor", () => {
  it("keeps the line breaks of the text and starts with nothing to save", () => {
    const html = renderedEditor("一行目\n二行目");
    expect(html).toContain("<textarea");
    expect(html).toContain("一行目\n二行目");
    expect(html).toMatch(/<button class="button" disabled="">保存<\/button>/);
  });
});
