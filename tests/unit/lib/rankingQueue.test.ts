import { expect, it, vi } from "vitest";
import { RankingQueue } from "../../../src/lib/rankingQueue";

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

it("runs every boundary ahead of the replaceable waiting job", async () => {
  const queue = new RankingQueue();
  const order: string[] = [];
  let release!: () => void;
  queue.schedule(() => new Promise<void>(resolve => { release = resolve; }), vi.fn());
  const run = (name: string, boundary = false) => queue.schedule(async () => { order.push(name); }, vi.fn(), boundary);
  run("preview");
  run("first", true);
  run("second", true);
  release();
  await vi.waitFor(() => expect(order).toEqual(["first", "second", "preview"]));
});
