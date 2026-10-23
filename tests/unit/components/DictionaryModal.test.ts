// @vitest-environment jsdom
import { act, createElement, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { DictionaryModal } from "../../../src/components/DictionaryModal";
import { recordConversionChoice, conversionLearningChoices } from "../../../src/lib/conversionLearning";

let dispose = () => {};
afterEach(() => { dispose(); vi.unstubAllGlobals(); });
function mount(overrides: Partial<ComponentProps<typeof DictionaryModal>> = {}) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const props = { personalWords: [], documentVocabularyProfile: { terms: ["航海"], revision: "1" },
    useDocumentVocabulary: false, onUseDocumentVocabularyChange: vi.fn(), onPersonalWordsChange: vi.fn(), ...overrides };
  act(() => root.render(createElement(DictionaryModal, props)));
  dispose = () => { act(() => root.unmount()); host.remove(); };
  return { host, props };
}
it("shows only the selected dictionary panel", () => {
  const { host } = mount();
  expect(host.querySelector('#dictionary-registered-tab')).toBeNull();
  for (const tab of ["personal", "detected", "learning", "personal"]) {
    act(() => host.querySelector<HTMLButtonElement>(`#dictionary-${tab}-tab`)!.click());
    expect([...host.querySelectorAll('[role="tabpanel"]')].map(p => p.id)).toEqual([`dictionary-${tab}-panel`]);
    expect(host.querySelector('[aria-selected="true"]')?.id).toBe(`dictionary-${tab}-tab`);
  }
});
it("lists learned choices and deletes individual and remaining preferences", () => {
  localStorage.clear(); recordConversionChoice("こうかい", "後悔"); recordConversionChoice("こうかい", "航海");
  const { host } = mount();
  act(() => host.querySelector<HTMLButtonElement>('#dictionary-learning-tab')!.click());
  expect(host.textContent).toContain("後悔");
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="こうかい → 後悔 の学習を削除"]')!.click());
  expect(conversionLearningChoices().map(c => c.text)).toEqual(["航海"]);
  act(() => [...host.querySelectorAll('button')].find(b => b.textContent === "学習履歴をすべて削除")!.click());
  expect(conversionLearningChoices()).toEqual([]);
  expect(host.textContent).toContain("学習履歴はありません");
});
function input(host: HTMLElement, label: string, value: string) {
  const field = host.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
it("registers a detected term as a kana dictionary word, not a snippet", () => {
  const { host, props } = mount();
  act(() => host.querySelector<HTMLButtonElement>('#dictionary-detected-tab')!.click());
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="航海 を個人語彙に追加"]')!.click());
  input(host, "検出語彙のかな読み", "コウカイ");
  act(() => host.querySelector('form')!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(props.onPersonalWordsChange).toHaveBeenCalledWith([expect.objectContaining({ reading: "こうかい", text: "航海", enabled: true })]);
});
it("reactivates a disabled personal word without duplicating it", () => {
  const word = { id: "word", reading: "こうかい", text: "航海", enabled: false, pos: "noun" as const };
  const { host, props } = mount({ personalWords: [word] });
  act(() => host.querySelector<HTMLButtonElement>('#dictionary-detected-tab')!.click());
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="航海 の個人語彙を有効にする"]')!.click());
  expect(props.onPersonalWordsChange).toHaveBeenCalledWith([{ ...word, enabled: true }]);
});
