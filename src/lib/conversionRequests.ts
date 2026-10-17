import { resolveConversionAnchor } from "./historyAnchor";

interface Range { from: number; to: number; originalText?: string }
export interface ConversionLease {
  id: string;
  range?: Range;
  sequence: number;
  predictive: boolean;
  controller: AbortController;
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

  register(id: string, range: Range | undefined, predictive = false): ConversionLease | undefined {
    const overlaps = [...this.active.values()].filter(item =>
      !item.controller.signal.aborted && range && item.range && rangesOverlap(range, item.range));
    if (predictive && overlaps.some(item => !item.predictive)) return undefined;
    for (const item of overlaps) this.cancel(item.id);
    const lease = { id, range, predictive, sequence: ++this.sequence, controller: new AbortController() };
    this.active.set(id, lease);
    return lease;
  }

  get(id: string): ConversionLease | undefined { return this.active.get(id); }
  refresh(documentText: string): void {
    for (const lease of this.active.values()) {
      if (!lease.range?.originalText || lease.controller.signal.aborted) continue;
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
