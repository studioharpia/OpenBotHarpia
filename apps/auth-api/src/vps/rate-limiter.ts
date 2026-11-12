/** Process-owned equivalent of the Worker's short rate-limit windows. */
export class VpsRateLimiter implements RateLimit {
  readonly #windows = new Map<string, { used: number; end: number }>();
  #nextSweep = 0;

  constructor(
    private readonly requests: number,
    private readonly periodSeconds: number,
    private readonly now: () => number = Date.now,
  ) {}

  async limit({ key }: { key: string }): Promise<{ success: boolean }> {
    const now = this.now();
    if (now >= this.#nextSweep) {
      for (const [id, window] of this.#windows) if (window.end <= now) this.#windows.delete(id);
      this.#nextSweep = now + this.periodSeconds * 1_000;
    }
    const previous = this.#windows.get(key);
    if (previous && previous.end > now) {
      if (previous.used >= this.requests) return { success: false };
      previous.used += 1;
    } else {
      // Exhausting the bounded table refuses new principals instead of evicting a live limit.
      if (!previous && this.#windows.size >= 100_000) return { success: false };
      this.#windows.set(key, { used: 1, end: now + this.periodSeconds * 1_000 });
    }
    return { success: true };
  }
}
