import { expect, it, vi } from "vitest";
import { RankingQueue } from "./rankingQueue";

it("bounds ranking to one running job and replaces the waiting job", async () => {
  const queue = new RankingQueue();
  let release!: () => void;
  const running = new Promise<void>(resolve => { release = resolve; });
  const skipped = vi.fn();
  const replaced = vi.fn();
  const latest = vi.fn().mockResolvedValue(undefined);
  queue.schedule(() => running, vi.fn());
  queue.schedule(replaced, skipped);
  queue.schedule(latest, vi.fn());
  expect(skipped).toHaveBeenCalledOnce();
  expect(latest).not.toHaveBeenCalled();
  release();
  await running;
  await Promise.resolve();
  expect(replaced).not.toHaveBeenCalled();
  expect(latest).toHaveBeenCalledOnce();
});
