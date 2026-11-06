import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createDefaultProvider, DEFAULT_SETTINGS, type ProviderConfig } from "../domain";
import { SettingsView } from "./SettingsView";

function renderedSettings(provider: ProviderConfig): string {
  const unused = () => Promise.resolve();
  return renderToStaticMarkup(createElement(SettingsView, {
    providers: [provider], settings: DEFAULT_SETTINGS, canInstall: false,
    onInstall: unused, onSaveProvider: unused, onDeleteProvider: unused, onSaveSettings: unused, onRestartOnboarding: () => undefined,
  }));
}

describe("the provider kinds", () => {
  it("leave the on-device model out until its program has a place to be served from", () => {
    expect(renderedSettings(createDefaultProvider(1))).not.toContain('value="litert-local"');
  });

  it("still name the on-device model for a provider that already uses it", () => {
    const local: ProviderConfig = { ...createDefaultProvider(1), id: "provider_local", kind: "litert-local" };
    expect(renderedSettings(local)).toContain('value="litert-local"');
  });
});
