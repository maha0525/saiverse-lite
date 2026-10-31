import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createDefaultPersona, createDefaultProvider } from "../domain";
import { DataView } from "./DataView";

describe("the full backup", () => {
  it("says what it leaves behind, so the user can decide to keep the ZIP", () => {
    const persona = createDefaultPersona(1);
    const unused = () => Promise.resolve();
    const html = renderToStaticMarkup(createElement(DataView, {
      persona, personas: [persona], providers: [createDefaultProvider(1)], busy: false, notice: "",
      onExportPersona: () => undefined, onExportMemory: unused, onExportBackup: unused, onImportBackup: unused, onImportNative: unused,
      onImportOfficial: () => Promise.resolve(true),
      onImportPack: () => Promise.reject(new Error("unused")),
      listInterruptedImports: () => Promise.resolve([]),
    }));
    expect(html).toContain("ペルソナまるごとパックの添付と手帳も含まない");
    expect(html).toContain("元の ZIP を自分で保管してください");
  });
});
