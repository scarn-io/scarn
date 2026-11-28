import {
  CONTENT_RATE_LIMIT_PER_IP_PER_MINUTE,
  CONTENT_RATE_LIMIT_PER_SHARE_PER_MINUTE,
  type ContentRateLimitDecision,
  type ContentRateLimiter,
} from "@scarn/core/tasks/artifact-share/application/content-rate-limiter";

type Window = { startedAtMs: number; count: number };

export type InMemoryContentRateLimiterOptions = {
  windowMs?: number;
  /** The limit for a key, by its prefix (`share:` / `ip:`); see `contentRateLimitKeys`. */
  limitFor?: (key: string) => number;
  /** The most keys tracked at once; the least recently used are dropped. */
  maxKeys?: number;
};

const defaultLimitFor = (key: string): number =>
  key.startsWith("ip:")
    ? CONTENT_RATE_LIMIT_PER_IP_PER_MINUTE
    : CONTENT_RATE_LIMIT_PER_SHARE_PER_MINUTE;

/**
 * A fixed-window counter per key, held in this process's memory.
 *
 * It is per instance: API instances (each Lambda, each Worker isolate) do not
 * share counts, so the effective limit grows with the number of warm
 * instances. That is enough to blunt one hot client on one instance; a
 * global limit belongs in front of the API (a CloudFront/WAF rate rule on the
 * content distribution). Memory stays bounded: past `maxKeys`, the least
 * recently hit key is evicted (a Map keeps insertion order, and every hit
 * re-inserts its key).
 */
export class InMemoryContentRateLimiter implements ContentRateLimiter {
  private readonly windows = new Map<string, Window>();
  private readonly windowMs: number;
  private readonly limitFor: (key: string) => number;
  private readonly maxKeys: number;

  constructor(options: InMemoryContentRateLimiterOptions = {}) {
    this.windowMs = options.windowMs ?? 60_000;
    this.limitFor = options.limitFor ?? defaultLimitFor;
    this.maxKeys = options.maxKeys ?? 10_000;
  }

  hit(key: string, now: Date): ContentRateLimitDecision {
    const nowMs = now.getTime();
    const existing = this.windows.get(key);
    const window =
      existing && nowMs - existing.startedAtMs < this.windowMs
        ? existing
        : { startedAtMs: nowMs, count: 0 };

    this.windows.delete(key);
    this.windows.set(key, window);
    this.evictOverflow();

    if (window.count >= this.limitFor(key)) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((window.startedAtMs + this.windowMs - nowMs) / 1000),
        ),
      };
    }
    window.count += 1;
    return { allowed: true, retryAfterSeconds: 0 };
  }

  private evictOverflow(): void {
    while (this.windows.size > this.maxKeys) {
      const oldest = this.windows.keys().next();
      if (oldest.done) {
        return;
      }
      this.windows.delete(oldest.value);
    }
  }
}
