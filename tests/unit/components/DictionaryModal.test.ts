// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { DictionaryModal } from "../../../src/components/DictionaryModal";

let dispose = () => {};
afterEach(() => { dispose(); vi.unstubAllGlobals(); });
function mount() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const props = { entries: [], personalWords: [], documentVocabularyProfile: { terms: ["航海"], revision: "1" },
    useDocumentVocabulary: false, onUseDocumentVocabularyChange: vi.fn(), onChange: vi.fn(), onPersonalWordsChange: vi.fn() };
  act(() => root.render(createElement(DictionaryModal, props)));
  dispose = () => { act(() => root.unmount()); host.remove(); };
  return { host, props };
}
it("shows only the selected dictionary panel", () => {
  const { host } = mount();
  for (const tab of ["personal", "detected", "registered", "personal"]) {
    act(() => host.querySelector<HTMLButtonElement>(`#dictionary-${tab}-tab`)!.click());
    expect([...host.querySelectorAll('[role="tabpanel"]')].map(p => p.id)).toEqual([`dictionary-${tab}-panel`]);
    expect(host.querySelector('[aria-selected="true"]')?.id).toBe(`dictionary-${tab}-tab`);
  }
});
