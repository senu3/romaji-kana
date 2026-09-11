// @vitest-environment jsdom
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkOllamaConnection,
  listLocalModels,
  type OllamaConnectionResult,
} from "../lib/ollamaConnection";
import { defaultSettings } from "../lib/settings";
import { deferred, mountHook } from "./testUtils";
import { useModelConnection } from "./useModelConnection";

vi.mock("../lib/ollamaConnection", () => ({ checkOllamaConnection: vi.fn(), listLocalModels: vi.fn() }));

function harness() {
  const options = {
    settings: { ...defaultSettings }, settingsRef: { current: { ...defaultSettings } },
    setupComplete: true, setupCompleteRef: { current: true },
    setStatus: vi.fn(), setSettings: vi.fn(), remoteMode: false,
  };
  return { options, hook: mountHook(() => useModelConnection(options)) };
}

describe("model connection lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(checkOllamaConnection).mockReset();
    vi.mocked(listLocalModels).mockReset();
  });

  it("ignores a previous check after a newer check completes", async () => {
    const oldCheck = deferred<OllamaConnectionResult>();
    const newCheck = deferred<OllamaConnectionResult>();
    vi.mocked(checkOllamaConnection).mockReturnValueOnce(oldCheck.promise).mockReturnValueOnce(newCheck.promise);
    const { hook } = harness();
    act(() => { void hook.current.handleCheckOllama(); });
    await act(async () => { newCheck.resolve({ models: [], modelLoaded: true, kind: "connected", message: "new result" }); });
    await act(async () => { oldCheck.reject(new Error("old failure")); });
    expect(hook.current.ollamaConnection).toMatchObject({ kind: "connected", message: "new result" });
  });

  it("cancels a scheduled connection check when unmounted", async () => {
    vi.mocked(checkOllamaConnection).mockResolvedValue({ models: [], modelLoaded: true, kind: "connected", message: "ready" });
    const { hook, options } = harness();
    await act(async () => { });
    options.settings = { ...options.settings, modelName: "another-model" };
    options.settingsRef.current = options.settings;
    hook.rerender();
    expect(vi.getTimerCount()).toBe(1);
    hook.unmount();
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(550); });
    expect(checkOllamaConnection).toHaveBeenCalledTimes(1);
  });
});
