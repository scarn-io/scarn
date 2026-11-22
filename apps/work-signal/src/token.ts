import { verifyHs256Jwt } from "./hs256";

/**
 * Verifies the short-lived HS256 JWT a worker presents when connecting.
 * Claims: `pid` (project id), `sub` (worker id), `oid` (org id, non-empty) and
 * `exp` (seconds since epoch).
 */
export interface WorkSignalClaims {
  pid: string;
  sub: string;
  oid: string;
  exp: number;
}

export async function verifyWorkSignalToken(
  token: string,
  secret: string,
  nowMs: number = Date.now(),
): Promise<WorkSignalClaims | null> {
  const payload = await verifyHs256Jwt(token, secret);
  if (!payload) return null;
  const { pid, sub, exp, oid } = payload;
  if (
    typeof pid !== "string" ||
    typeof sub !== "string" ||
    typeof exp !== "number" ||
    typeof oid !== "string" ||
    oid === ""
  ) {
    return null;
  }
  if (exp * 1000 <= nowMs) return null;
  return { pid, sub, oid, exp };
}
