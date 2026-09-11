import { EditorState, type TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, vi } from "vitest";
import { ghostSuggestionField } from "../components/MarkdownEditor";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

export function mountHook<T>(useHook: () => T) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let current: T;
  let mounted = true;
  function Harness() {
    current = useHook();
    return null;
  }
  const render = () => act(() => root.render(createElement(Harness)));
  const unmount = () => {
    if (!mounted) return;
    act(() => root.unmount());
    host.remove();
    mounted = false;
  };
  cleanups.push(unmount);
  render();
  return { get current() { return current!; }, rerender: render, unmount };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// Use real CodeMirror transactions, without a DOM view or layout timers.
export function stateEditor(content: string, onChange?: (text: string) => void) {
  let state = EditorState.create({ doc: content, extensions: [ghostSuggestionField] });
  const dispatch = vi.fn((spec: TransactionSpec) => {
    const transaction = state.update(spec);
    state = transaction.state;
    if (transaction.docChanged) onChange?.(state.doc.toString());
  });
  const view = {
    get state() { return state; },
    dispatch,
    focus: vi.fn(),
  } as unknown as EditorView;
  return { view, dispatch };
}
