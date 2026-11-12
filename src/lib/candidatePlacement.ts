import type { EditorView } from "@codemirror/view";

interface Rect { left: number; right: number; top: number; bottom: number }
export interface CandidatePlacement {
  left: number; top: number; maxWidth: number; maxHeight: number; inline: boolean;
}

/** Client coordinates for inline completion, candidate menus and React panels. */
export function placeCandidate(anchor: Rect, bounds: Rect, size: { width: number; height: number }, preferInline = false): CandidatePlacement | null {
  if (anchor.bottom < bounds.top || anchor.top > bounds.bottom || anchor.right < bounds.left || anchor.left > bounds.right) return null;
  const maxWidth = Math.max(0, Math.min(420, bounds.right - bounds.left));
  const width = Math.min(size.width, maxWidth);
  if (preferInline && size.height <= anchor.bottom - anchor.top + 12 &&
    anchor.right + 6 + size.width <= bounds.right && anchor.top + size.height <= bounds.bottom) {
    return { left: anchor.right + 6, top: anchor.top, maxWidth, maxHeight: bounds.bottom - anchor.top, inline: true };
  }
  const below = Math.max(0, bounds.bottom - anchor.bottom - 6);
  const above = Math.max(0, anchor.top - bounds.top - 6);
  const useBelow = below >= Math.min(size.height, 440) || below >= above;
  const maxHeight = Math.min(440, useBelow ? below : above);
  return { left: Math.max(bounds.left, Math.min(anchor.left, bounds.right - width)),
    top: useBelow ? anchor.bottom + 6 : Math.max(bounds.top, anchor.top - Math.min(size.height, maxHeight) - 6),
    maxWidth, maxHeight, inline: false };
}

export function measureCandidate(view: EditorView, position: number, element: HTMLElement, inline = false) {
  const anchor = view.coordsAtPos(Math.min(position, view.state.doc.length), 1);
  if (!anchor) return null;
  const editor = view.scrollDOM.getBoundingClientRect();
  const viewport = window.visualViewport;
  const left = viewport?.offsetLeft ?? 0, top = viewport?.offsetTop ?? 0;
  const bounds = { left: Math.max(left + 8, editor.left), right: Math.min(left + (viewport?.width ?? innerWidth) - 8, editor.right),
    top: Math.max(top + 8, editor.top), bottom: Math.min(top + (viewport?.height ?? innerHeight) - 8, editor.bottom) };
  return placeCandidate(anchor, bounds, { width: element.getBoundingClientRect().width, height: element.scrollHeight }, inline);
}

export function applyCandidatePlacement(element: HTMLElement, placement: CandidatePlacement | null) {
  element.style.visibility = placement ? "visible" : "hidden";
  if (!placement) return;
  element.dataset.placement = placement.inline ? "inline" : "floating";
  Object.assign(element.style, { position: "fixed", left: `${placement.left}px`, top: `${placement.top}px`,
    maxWidth: `${placement.maxWidth}px`, maxHeight: `${placement.maxHeight}px` });
}
