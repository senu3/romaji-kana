import type { EditorView } from "@codemirror/view";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { candidatePresentation } from "../lib/candidatePresentation";
import type { ConversionSession } from "../lib/conversionSession";
import { requiresExplicitAcceptance } from "../lib/readingAssessment";
import type { GhostConversionSuggestion } from "../lib/types";

export interface CandidateListTarget {
  session: ConversionSession;
  anchor: { from: number; to: number };
  ghost?: GhostConversionSuggestion;
}

export function CandidateList({ view, suggestion, target, onAccept, onDismiss, onOpen, onSelect, onSpeculate, onClose }: {
  view: EditorView;
  suggestion: GhostConversionSuggestion | null;
  target: CandidateListTarget | null;
  onAccept: () => void;
  onDismiss: () => void;
  onOpen: () => void;
  onSelect: (id: string) => void;
  onSpeculate: () => void;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLElement>(null);
  const titleId = useId();
  const [position, setPosition] = useState({ left: 0, top: 0, visible: false, maxHeight: 440 });
  const [detailsOpen, setDetailsOpen] = useState(false);
  const candidate = target ? target.session.candidates.find(c => c.id === target.session.selectedId)?.result : null;
  const text = candidate?.text ?? suggestion?.convertedText ?? "";
  const changes = candidate?.changes ?? suggestion?.changes;
  const strategy = target ? candidate?.conversionStrategy : suggestion?.conversionStrategy;
  const explicit = requiresExplicitAcceptance({ conversionStrategy: strategy, changes });
  const presentation = candidatePresentation({ conversionStrategy: strategy });
  const anchor = target?.anchor ?? suggestion!;

  useLayoutEffect(() => {
    let frame = 0;
    const place = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const panel = panelRef.current;
        const coords = view.coordsAtPos(Math.min(anchor.to, view.state.doc.length));
        if (!panel || !coords) { setPosition(p => ({ ...p, visible: false })); return; }
        const bounds = view.scrollDOM.getBoundingClientRect();
        const topEdge = Math.max(8, bounds.top);
        const bottomEdge = Math.min(window.innerHeight - 8, bounds.bottom);
        const spaceBelow = Math.max(0, bottomEdge - coords.bottom - 8);
        const spaceAbove = Math.max(0, coords.top - topEdge - 8);
        const below = spaceBelow >= Math.min(440, panel.scrollHeight) || spaceBelow >= spaceAbove;
        const maxHeight = Math.max(64, Math.min(440, below ? spaceBelow : spaceAbove));
        const top = below ? coords.bottom + 8 : Math.max(topEdge, coords.top - Math.min(panel.offsetHeight, maxHeight) - 8);
        const left = Math.max(8, Math.min(coords.left, window.innerWidth - panel.offsetWidth - 8));
        setPosition({ top, left, maxHeight, visible: coords.bottom >= topEdge && coords.top <= bottomEdge });
      });
    };
    place();
    const observer = new ResizeObserver(place);
    if (panelRef.current) observer.observe(panelRef.current);
    window.addEventListener("resize", place);
    document.addEventListener("scroll", place, true);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); window.removeEventListener("resize", place); document.removeEventListener("scroll", place, true); };
  }, [view, anchor.from, anchor.to, text, target, detailsOpen]);

  useEffect(() => {
    if (target) panelRef.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus({ preventScroll: true });
  }, [target]);

  // Escape collapses alternatives before dismissing the preview, including when focus is in the editor.
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || (!panelRef.current?.contains(document.activeElement) && !view.hasFocus)) return;
      event.preventDefault(); event.stopPropagation();
      if (target) onClose(); else onDismiss();
    };
    document.addEventListener("keydown", escape, true);
    return () => document.removeEventListener("keydown", escape, true);
  }, [view, target, onClose, onDismiss]);

  return createPortal(
    <section ref={panelRef} className="conversion-popover" role="dialog" aria-modal="false"
      aria-labelledby={titleId} style={{ left: position.left, top: position.top, maxHeight: position.maxHeight, visibility: position.visible ? "visible" : "hidden" }}
      onKeyDown={event => {
        if (!target || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        const buttons = Array.from(panelRef.current!.querySelectorAll<HTMLButtonElement>(".candidate-list-options button"));
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
        if (current < 0 || !buttons.length) return;
        event.preventDefault();
        const index = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
        buttons[index].focus();
      }}>
      <header className="conversion-popover-heading">
        <span id={titleId}>{target ? "ほかの候補" : "変換候補"}</span>
        {strategy ? <span className="conversion-kind">{presentation.label}</span> : null}
        <button type="button" className="candidate-action" onClick={target ? onClose : onDismiss} aria-label={target ? "候補一覧を閉じる" : "候補を閉じる"}>閉じる <kbd>Esc</kbd></button>
      </header>
      {target ? (
        <>
          <p className="candidate-help">同じ読みの候補です。選んだあとに確定できます。</p>
          <ul className="candidate-list-options" aria-label="同じ読みの候補">
            {target.session.candidates.map(c => (
              <li key={c.id}><button type="button" aria-pressed={c.id === target.session.selectedId} onClick={() => onSelect(c.id)}>
                <span>{c.result.text}</span>{c.id === target.session.selectedId ? <small>選択中</small> : null}
              </button></li>
            ))}
          </ul>
          {target.session.candidates.length < 2 ? <p className="candidate-help">ほかの表記はありません。</p> : null}
          <footer className="candidate-reconsider">
            <button type="button" className="candidate-action" onClick={onSpeculate}>読みも含めて見直す</button>
            <p className="candidate-help">入力と前後の文脈から新しい候補を推測します。確定するまで本文は変わりません。</p>
          </footer>
        </>
      ) : (
        <>
          <p className="cm-ghost-text-suggestion" aria-live="polite">{text}</p>
          {explicit ? <p className="candidate-notice">{changes?.readingAssessment?.status !== "verified" ? "読み未確認の候補です。内容を確認して確定してください。" : "入力の読みを変更しています。内容を確認して確定してください。"}</p> : null}
          <div className="candidate-toolbar">
            <button type="button" className="candidate-accept" onClick={onAccept}>確定 <kbd>Tab</kbd></button>
            <button type="button" className="candidate-action" onClick={onOpen} title="Ctrl/Cmd + /">ほかの候補</button>
            <button type="button" className="candidate-action candidate-details-toggle" aria-expanded={detailsOpen} onClick={() => setDetailsOpen(!detailsOpen)}>変更の詳細</button>
          </div>
          {detailsOpen ? <dl className="candidate-details">
            <dt>変換前</dt><dd>{suggestion?.originalText}</dd>
            {changes?.sourceReading ? <><dt>元の読み</dt><dd>{changes.sourceReading}</dd></> : null}
            {changes?.resultReading ? <><dt>候補の読み</dt><dd>{changes.resultReading}</dd></> : null}
            {!!changes?.additions?.length ? <><dt>読みの追加</dt><dd>{changes.additions.join("、")}</dd></> : null}
          </dl> : null}
        </>
      )}
    </section>, document.body,
  );
}
