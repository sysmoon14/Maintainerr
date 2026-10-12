/**
 * Paces requests to Silo under its per-key rate limit.
 *
 * Silo limits each key per second (20 a second, with a burst of 20, on its
 * default tier) and answers anything over with 429. A rule run evaluates many
 * items at once, each needing a few reads, so unpaced it bursts far past that
 * and items fail their lookups. The retry policy waits out one 429, but a
 * whole run's worth of them still loses items, so the requests are spaced
 * here instead: a token bucket refilled at a little under the limit.
 *
 * Every Silo response names the key's per-second limit in X-RateLimit-Limit,
 * so a key on a higher tier is paced to its own limit after the first reply.
 */
export class SiloRequestPacer {
  // Silo's default tier, until a response names the key's own.
  static readonly DEFAULT_LIMIT_PER_SECOND = 20;
  // Requests are spaced to this share of the limit, leaving headroom for the
  // other clients of the same key and for clock drift.
  static readonly HEADROOM = 0.9;

  private ratePerSecond: number;
  private tokens: number;
  private lastRefillMs: number;
  // Waiters are served in order, so a burst cannot starve an early request.
  private queue: Promise<void> = Promise.resolve();

  constructor(
    limitPerSecond = SiloRequestPacer.DEFAULT_LIMIT_PER_SECOND,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {
    this.ratePerSecond = SiloRequestPacer.paced(limitPerSecond);
    this.tokens = this.ratePerSecond;
    this.lastRefillMs = this.now();
  }

  /** Resolves when the next request may be sent. */
  acquire(): Promise<void> {
    const turn = this.queue.then(() => this.takeToken());
    this.queue = turn.catch(() => undefined);
    return turn;
  }

  /** Adopts the per-second limit a Silo response declared, if any. */
  observeLimit(header: unknown): void {
    const limit = Number(header);
    if (!Number.isFinite(limit) || limit <= 0) return;
    const paced = SiloRequestPacer.paced(limit);
    if (paced === this.ratePerSecond) return;
    this.refill();
    this.ratePerSecond = paced;
    this.tokens = Math.min(this.tokens, paced);
  }

  get requestsPerSecond(): number {
    return this.ratePerSecond;
  }

  private async takeToken(): Promise<void> {
    this.refill();
    while (this.tokens < 1) {
      await this.sleep(
        Math.ceil(((1 - this.tokens) / this.ratePerSecond) * 1000),
      );
      this.refill();
    }
    this.tokens -= 1;
  }

  private refill(): void {
    const nowMs = this.now();
    const elapsedSeconds = Math.max(0, nowMs - this.lastRefillMs) / 1000;
    this.lastRefillMs = nowMs;
    this.tokens = Math.min(
      this.ratePerSecond,
      this.tokens + elapsedSeconds * this.ratePerSecond,
    );
  }

  private static paced(limitPerSecond: number): number {
    return Math.max(1, Math.floor(limitPerSecond * SiloRequestPacer.HEADROOM));
  }
}
