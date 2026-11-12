import { ViewPlugin, type EditorView } from "@codemirror/view";
import { StateEffect, StateField } from "@codemirror/state";
import { applyCandidatePlacement, measureCandidate } from "../lib/candidatePlacement";

export const setCandidatePanelOpen = StateEffect.define<boolean>();
export const candidatePanelOpen = StateField.define<boolean>({ create: () => false,
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(setCandidatePanelOpen)) value = effect.value;
    return value;
  },
});

/** Lifecycle and viewport tracking for non-document candidate content. */
export function candidateSurface(anchor: (view: EditorView) => number | null,
  create: (view: EditorView) => { dom: HTMLElement; update: () => void }, preferInline = false) {
  return ViewPlugin.fromClass(class {
    content?: ReturnType<typeof create>;
    observer?: ResizeObserver;
    constructor(readonly view: EditorView) {
      window.visualViewport?.addEventListener("resize", this.measure);
      window.visualViewport?.addEventListener("scroll", this.measure);
      this.update();
    }
    measure = () => this.view.requestMeasure({ key: this,
      read: () => {
        const position = anchor(this.view);
        return this.content && position !== null ? measureCandidate(this.view, position, this.content.dom,
          preferInline && this.view.state.doc.lineAt(position).to === position) : null;
      },
      write: placement => { if (this.content) applyCandidatePlacement(this.content.dom, placement); },
    });
    update() {
      if (this.view.state.field(candidatePanelOpen, false) || anchor(this.view) === null) { this.remove(); return; }
      if (!this.content) {
        this.content = create(this.view);
        this.content.dom.classList.add("candidate-surface");
        this.content.dom.style.visibility = "hidden";
        this.view.dom.append(this.content.dom);
        this.observer = new ResizeObserver(this.measure);
        this.observer.observe(this.content.dom);
      }
      this.content.update();
      this.measure();
    }
    remove() { this.observer?.disconnect(); this.content?.dom.remove(); this.content = undefined; }
    destroy() {
      this.remove();
      window.visualViewport?.removeEventListener("resize", this.measure);
      window.visualViewport?.removeEventListener("scroll", this.measure);
    }
  }, { eventHandlers: { scroll() { this.measure(); } } });
}
