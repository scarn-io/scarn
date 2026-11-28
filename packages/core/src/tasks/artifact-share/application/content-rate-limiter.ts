/**
 * Rate limiting for anonymous reads on the content origin (plan decision 15).
 * Share traffic is limited per share and per client IP, and never counts
 * against the bundle owner's read cap. Callers hit one key per dimension,
 * e.g. {@link contentRateLimitKeys}, and refuse with 429 when any is denied.
 */
export type ContentRateLimitDecision = {
  allowed: boolean;
  /** Seconds until the window resets; 0 when allowed. */
  retryAfterSeconds: number;
};

export interface ContentRateLimiter {
  hit(key: string, now: Date): ContentRateLimitDecision;
}

/** Requests per minute allowed for one share link (all clients together). */
export const CONTENT_RATE_LIMIT_PER_SHARE_PER_MINUTE = 600;
/** Requests per minute allowed for one client IP (all shares together). */
export const CONTENT_RATE_LIMIT_PER_IP_PER_MINUTE = 300;

export const contentRateLimitKeys = (input: {
  shareId: string;
  clientIp: string | null;
}): { share: string; ip: string | null } => ({
  share: `share:${input.shareId}`,
  ip: input.clientIp ? `ip:${input.clientIp}` : null,
});
