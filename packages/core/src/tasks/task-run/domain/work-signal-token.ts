import { signHs256Jwt } from "@scarn/core/lib/hs256";

/**
 * Signs the short-lived HS256 JWT a worker presents to the work-signal Worker
 * (`apps/work-signal/src/token.ts` verifies it). Claims: `pid` (project id),
 * `oid` (the project's org id, so the Worker can limit per org), `sub`
 * (worker id), `exp` (seconds since epoch).
 */
export type WorkSignalTokenClaims = {
  pid: string;
  oid: string;
  sub: string;
  exp: number;
};

export const signWorkSignalToken = (
  claims: WorkSignalTokenClaims,
  secret: string,
): Promise<string> => signHs256Jwt(claims, secret);
