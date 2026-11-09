interface Job { run: () => Promise<void>; skip: () => void }

/** Run one model job at a time. Boundaries retain their place ahead of replaceable work. */
export class RankingQueue {
  private running = false;
  private waiting?: Job;
  private boundaries: Job[] = [];
  schedule(run: Job["run"], skip: Job["skip"], boundary = false): void {
    if (boundary) this.boundaries.push({ run, skip });
    else {
      this.waiting?.skip();
      this.waiting = { run, skip };
    }
    void this.drain();
  }
  clear(): void {
    for (const job of this.boundaries.splice(0)) job.skip();
    this.waiting?.skip();
    this.waiting = undefined;
  }
  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.boundaries.length || this.waiting) {
        const job = this.boundaries.shift() ?? this.takeWaiting();
        await job.run();
      }
    } finally { this.running = false; }
  }
  private takeWaiting(): Job {
    const job = this.waiting!;
    this.waiting = undefined;
    return job;
  }
}
