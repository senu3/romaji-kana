interface Job { run: () => Promise<void>; skip: () => void }

/** One model request and one replaceable waiting request per editor. */
export class RankingQueue {
  private running = false;
  private waiting?: Job;
  schedule(run: Job["run"], skip: Job["skip"]): void {
    this.waiting?.skip();
    this.waiting = { run, skip };
    void this.drain();
  }
  clear(): void { this.waiting?.skip(); this.waiting = undefined; }
  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.waiting) {
        const job = this.waiting;
        this.waiting = undefined;
        await job.run();
      }
    } finally { this.running = false; }
  }
}
