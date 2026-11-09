import { resolveConversionAnchor } from "./historyAnchor";
import type { ChangeDesc } from "@codemirror/state";

interface Range { from: number; to: number; originalText?: string }
export interface ConversionLease {
  id: string;
  range?: Range;
  sequence: number;
  predictive: boolean;
  controller: AbortController;
  trackEdits: boolean;
}

export function rangesOverlap(left: Range, right: Range): boolean {
  return left.from < right.to && right.from < left.to;
}

/** Shared ownership for both queues. Disjoint work can finish independently,
 * while an older response cannot take over the single candidate display. */
export class ConversionRequests {
  private active = new Map<string, ConversionLease>();
  private sequence = 0;
  private displayedSequence = 0;
  private replacing = new Set<string>();

  register(id: string, range: Range | undefined, predictive = false, trackEdits = false): ConversionLease | undefined {
    const overlaps = [...this.active.values()].filter(item =>
      !item.controller.signal.aborted && range && item.range && rangesOverlap(range, item.range));
    if (predictive && overlaps.some(item => !item.predictive)) return undefined;
    for (const item of overlaps) this.cancel(item.id);
    const lease = { id, range, predictive, trackEdits, sequence: ++this.sequence, controller: new AbortController() };
    this.active.set(id, lease);
    return lease;
  }

  get(id: string): ConversionLease | undefined { return this.active.get(id); }
  mapEdits(changes: ChangeDesc): void {
    for (const lease of this.active.values()) {
      if (!lease.trackEdits || !lease.range || !this.valid(lease.id) || this.replacing.has(lease.id)) continue;
      const { from, to } = lease.range;
      let touched = false;
      changes.iterChangedRanges((start, end) => { touched ||= start < to && end > from; });
      if (touched) this.cancel(lease.id);
      else lease.range = { ...lease.range, from: changes.mapPos(from, 1), to: changes.mapPos(to, -1) };
    }
  }
  replace(id: string, range: Range, commit: () => boolean): boolean {
    const lease = this.active.get(id);
    if (!lease?.trackEdits) return commit();
    this.replacing.add(id);
    try {
      const applied = commit();
      if (applied) lease.range = range;
      return applied;
    } finally { this.replacing.delete(id); }
  }
  refresh(documentText: string): void {
    for (const lease of this.active.values()) {
      if (!lease.range?.originalText || lease.controller.signal.aborted) continue;
      if (this.replacing.has(lease.id)) continue;
      if (lease.trackEdits) {
        if (documentText.slice(lease.range.from, lease.range.to) !== lease.range.originalText) this.cancel(lease.id);
        continue;
      }
      const resolved = resolveConversionAnchor(documentText, { ...lease.range,
        originalText: lease.range.originalText, docVersion: 0 });
      if (resolved) lease.range = { ...lease.range, from: resolved.from, to: resolved.to };
      else this.cancel(lease.id);
    }
  }
  valid(id: string): boolean {
    const lease = this.active.get(id);
    return Boolean(lease && !lease.controller.signal.aborted);
  }
  display(id: string): boolean {
    const lease = this.active.get(id);
    if (!lease || !this.valid(id) || lease.sequence < this.displayedSequence) return false;
    this.displayedSequence = lease.sequence;
    return true;
  }
  cancel(id: string): void { this.active.get(id)?.controller.abort(); }
  cancelPredictions(): void {
    for (const lease of this.active.values()) if (lease.predictive) lease.controller.abort();
  }
  finish(id: string): void { this.active.delete(id); }
  clear(): void {
    for (const lease of this.active.values()) lease.controller.abort();
    this.active.clear();
  }
}
