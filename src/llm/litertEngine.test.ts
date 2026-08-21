import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatLoadingElapsedMessage } from "./litertEngine";

const createMock = vi.fn();
const loadLiteRtLmMock = vi.fn(async (..._args: unknown[]) => undefined);

vi.mock("@litert-lm/core", () => ({
  Engine: { create: (...args: unknown[]) => createMock(...args) },
  loadLiteRtLm: (...args: unknown[]) => loadLiteRtLmMock(...args),
}));

type LitertEngineModule = typeof import("./litertEngine");

// litertEngine.ts はモジュールレベルの単一状態 (currentEngine / currentModelId /
// wasmLoaded) を持つため、テストごとに vi.resetModules() で新しいインスタンスに
// してから import し直す。使い回すと前のテストの読み込み状態が漏れる。
async function freshModule(): Promise<LitertEngineModule> {
  vi.resetModules();
  return import("./litertEngine");
}

function fakeEngine(deleteFn = vi.fn(async () => undefined)) {
  return { delete: deleteFn, createConversation: vi.fn() };
}

beforeEach(() => {
  createMock.mockReset();
  loadLiteRtLmMock.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ensureEngine", () => {
  it("reuses the held engine when the same modelId is requested again", async () => {
    const engine = fakeEngine();
    createMock.mockResolvedValue(engine);
    const mod = await freshModule();

    const first = await mod.ensureEngine("gemma-4-e2b-it-web");
    const second = await mod.ensureEngine("gemma-4-e2b-it-web");

    expect(first).toBe(engine);
    expect(second).toBe(engine);
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(loadLiteRtLmMock).toHaveBeenCalledTimes(1);
  });

  it("passes benchmarkEnabled: true, without which speed cannot be measured", async () => {
    const engine = fakeEngine();
    createMock.mockResolvedValue(engine);
    const mod = await freshModule();

    await mod.ensureEngine("gemma-4-e2b-it-web");

    expect(createMock).toHaveBeenCalledWith(expect.objectContaining({ benchmarkEnabled: true }));
  });

  it("disposes the old engine and loads a new one when the modelId changes", async () => {
    const oldDelete = vi.fn(async () => undefined);
    const oldEngine = fakeEngine(oldDelete);
    const newEngine = fakeEngine();
    createMock.mockResolvedValueOnce(oldEngine).mockResolvedValueOnce(newEngine);
    const mod = await freshModule();

    const first = await mod.ensureEngine("gemma-4-e2b-it-web");
    const second = await mod.ensureEngine("gemma-4-e4b-it-web");

    expect(first).toBe(oldEngine);
    expect(second).toBe(newEngine);
    expect(oldDelete).toHaveBeenCalledTimes(1);
    expect(createMock).toHaveBeenCalledTimes(2);
    // loadLiteRtLm() は2回目を呼ぶと必ず例外になる (§15.2) — モデルを差し替えても
    // 一度しか呼ばれないことを確認する。
    expect(loadLiteRtLmMock).toHaveBeenCalledTimes(1);
  });

  it("shares one in-flight load across concurrent calls for the same modelId", async () => {
    let resolveCreate!: (engine: unknown) => void;
    createMock.mockReturnValue(new Promise((resolve) => { resolveCreate = resolve; }));
    const mod = await freshModule();

    const p1 = mod.ensureEngine("gemma-4-e2b-it-web");
    const p2 = mod.ensureEngine("gemma-4-e2b-it-web");
    const engine = fakeEngine();
    resolveCreate(engine);

    const [first, second] = await Promise.all([p1, p2]);

    expect(first).toBe(engine);
    expect(second).toBe(engine);
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it("reflects loading -> ready in getEngineStatus() and notifies subscribers", async () => {
    const engine = fakeEngine();
    createMock.mockResolvedValue(engine);
    const mod = await freshModule();
    const seen: string[] = [];
    mod.subscribe((status) => seen.push(status.status));

    expect(mod.getEngineStatus().status).toBe("idle");
    await mod.ensureEngine("gemma-4-e2b-it-web");

    expect(seen).toEqual(["loading", "ready"]);
    expect(mod.getEngineStatus()).toMatchObject({ status: "ready", modelId: "gemma-4-e2b-it-web", error: null });
    expect(mod.getEngineStatus().startedAt).not.toBeNull();
  });

  it("moves to error status and rejects when Engine.create() fails", async () => {
    createMock.mockRejectedValue(new Error("boom"));
    const mod = await freshModule();

    await expect(mod.ensureEngine("gemma-4-e2b-it-web")).rejects.toThrow("boom");
    expect(mod.getEngineStatus()).toMatchObject({ status: "error", error: "boom" });
  });
});

describe("disposeEngine", () => {
  it("deletes the engine and returns to idle", async () => {
    const deleteFn = vi.fn(async () => undefined);
    createMock.mockResolvedValue(fakeEngine(deleteFn));
    const mod = await freshModule();
    await mod.ensureEngine("gemma-4-e2b-it-web");
    expect(mod.getEngineStatus().status).toBe("ready");

    await mod.disposeEngine();

    expect(deleteFn).toHaveBeenCalledTimes(1);
    expect(mod.getEngineStatus()).toEqual({ status: "idle", modelId: null, startedAt: null, error: null });
  });
});

describe("formatLoadingElapsedMessage", () => {
  it("reports whole seconds elapsed since loading started", () => {
    expect(formatLoadingElapsedMessage(0, 23_000)).toBe("端末内モデルを読み込んでいます…（23秒経過 / 初回は1分ほどかかります）");
  });

  it("floors partial seconds rather than rounding up", () => {
    expect(formatLoadingElapsedMessage(0, 1_999)).toBe("端末内モデルを読み込んでいます…（1秒経過 / 初回は1分ほどかかります）");
  });

  it("never reports a negative elapsed time even if clocks are inconsistent", () => {
    expect(formatLoadingElapsedMessage(10_000, 9_000)).toBe("端末内モデルを読み込んでいます…（0秒経過 / 初回は1分ほどかかります）");
  });
});
