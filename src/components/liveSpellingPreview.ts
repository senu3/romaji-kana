import type { EditorState } from "@codemirror/state";
import { ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view";
import { applyCandidatePlacement, measureCandidate, type CandidatePlacement } from "../lib/candidatePlacement";
import { liveKanaSource } from "../lib/liveKanaState";
import { predictLocalSpelling } from "../lib/predictLocalSpelling";
import type { AppSettings } from "../lib/types";

/** Read-only prediction: the panel never participates in editor selection or key handling. */
export function liveSpellingPreview(settings: () => AppSettings, blocked: (state: EditorState) => boolean) {
  return ViewPlugin.fromClass(class {
    panel = document.createElement("div");
    timer?: ReturnType<typeof setTimeout>;
    request?: AbortController;
    reading = "";
    runStart = -1;
    displayedReading = "";
    readonly measure = {
      read: (view: EditorView) => {
        const completion = view.dom.querySelector<HTMLElement>(".cm-autosuggest-ghost:not([hidden])");
        const avoid = completion?.style.visibility === "visible" ? completion.getBoundingClientRect() : undefined;
        return this.runStart < 0 ? null : measureCandidate(view, this.runStart, this.panel, false, avoid);
      },
      write: (placement: CandidatePlacement | null) => applyCandidatePlacement(this.panel, placement),
    };
    reposition = () => {
      if (!this.panel.hidden) this.view.requestMeasure(this.measure);
    };
    observer = new MutationObserver(this.reposition);
    constructor(readonly view: EditorView) {
      this.panel.className = "live-spelling-preview";
      this.panel.hidden = true;
      view.dom.appendChild(this.panel);
      view.scrollDOM.addEventListener("scroll", this.reposition);
      window.visualViewport?.addEventListener("resize", this.reposition);
      window.visualViewport?.addEventListener("scroll", this.reposition);
    }
    update(update: ViewUpdate) {
      if (update.geometryChanged || update.viewportChanged || update.selectionSet) this.reposition();
      const { state } = this.view;
      const live = state.field(liveKanaSource, false);
      const cursor = state.selection.main;
      const text = live && cursor.empty && cursor.head === live.to && this.view.hasFocus &&
        !this.view.composing && !blocked(state) && settings().inputMode !== "romaji"
        ? state.sliceDoc(live.from, live.to) : "";
      const reading = /^[ぁ-ゖー]+$/u.test(text) ? text : "";
      const start = live?.from ?? -1;
      // Keep the visible result while the same word grows, including the
      // consonant between two completed kana (ほん → ほんt → ほんと).
      const pendingKana = /^[ぁ-ゖー]+[a-z]+$/u.test(text);
      if (start !== this.runStart || (!reading && !pendingKana) || !text.startsWith(this.displayedReading)) {
        this.panel.hidden = true;
        this.displayedReading = "";
      }
      if (reading === this.reading && start === this.runStart) return;
      this.reading = reading;
      this.runStart = start;
      this.cancel();
      if (!reading) return;
      const controller = this.request = new AbortController();
      this.timer = setTimeout(async () => {
        try {
          const spelling = await predictLocalSpelling(reading, settings(), controller.signal);
          if (controller.signal.aborted) return;
          if (spelling === reading) {
            this.panel.hidden = true;
            this.displayedReading = "";
            return;
          }
          this.displayedReading = reading;
          this.panel.textContent = spelling;
          if (this.panel.hidden) this.panel.style.visibility = "hidden";
          this.panel.hidden = false;
          const completion = this.view.dom.querySelector(".cm-autosuggest-ghost");
          if (completion) this.observer.observe(completion, { attributes: true, attributeFilter: ["style", "hidden"] });
          this.reposition();
        } catch {
          if (!controller.signal.aborted) this.panel.hidden = true;
        }
      }, 140);
    }
    cancel() {
      clearTimeout(this.timer);
      this.request?.abort();
    }
    destroy() {
      this.cancel();
      this.observer.disconnect();
      this.view.scrollDOM.removeEventListener("scroll", this.reposition);
      window.visualViewport?.removeEventListener("resize", this.reposition);
      window.visualViewport?.removeEventListener("scroll", this.reposition);
      this.panel.remove();
    }
  });
}
