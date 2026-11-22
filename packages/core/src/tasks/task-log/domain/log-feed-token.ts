import { signHs256Jwt } from "@scarn/core/lib/hs256";

/**
 * Signs the short-lived HS256 JWT that grants access to one task run's live
 * log feed (`apps/work-signal/src/log-feed-token.ts` verifies it). Claims:
 * `tid` (task run id), `pid` (project id), `oid` (the project's org id),
 * `scope` (`write` for the worker
 * appending lines, `read` for viewers), `exp` (seconds since epoch). Signed
 * with `LOG_FEED_TOKEN_SECRET`, never the work-signal secret, so the two token
 * kinds cannot stand in for each other.
 */
export type LogFeedTokenScope = "write" | "read";

export type LogFeedTokenClaims = {
  tid: string;
  pid: string;
  oid: string;
  scope: LogFeedTokenScope;
  exp: number;
};

export const signLogFeedToken = (
  claims: LogFeedTokenClaims,
  secret: string,
): Promise<string> => signHs256Jwt(claims, secret);
