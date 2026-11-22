import { verifyHs256Jwt } from "./hs256";

/**
 * Verifies the short-lived HS256 JWT that grants access to one task run's live
 * log feed. Claims: `tid` (task run id), `pid` (project id), `scope`
 * (`write` | `read`), `exp` (seconds since epoch), and `oid` (org id). A token
 * is accepted only when its `tid` matches the task run in the URL, its `scope`
 * is the one the endpoint requires, and any `oid` it carries is a non-empty
 * string. Write tokens must carry `oid`; read tokens may omit it, since readers
 * are anonymous and the edge doesn't key reader limits on the org.
 */
export type LogFeedScope = "write" | "read";

export interface LogFeedClaims {
  tid: string;
  pid: string;
  scope: LogFeedScope;
  exp: number;
  oid?: string;
}

export async function verifyLogFeedToken(
  token: string,
  secret: string,
  expected: { taskRunId: string; scope: LogFeedScope },
  nowMs: number = Date.now(),
): Promise<LogFeedClaims | null> {
  const payload = await verifyHs256Jwt(token, secret);
  if (!payload) return null;
  const { tid, pid, scope, exp, oid } = payload;
  if (
    typeof tid !== "string" ||
    typeof pid !== "string" ||
    typeof exp !== "number"
  ) {
    return null;
  }
  if (oid !== undefined && (typeof oid !== "string" || oid === "")) {
    return null;
  }
  if (expected.scope === "write" && oid === undefined) return null;
  if (scope !== expected.scope || tid !== expected.taskRunId) return null;
  if (exp * 1000 <= nowMs) return null;
  const claims: LogFeedClaims = { tid, pid, scope: expected.scope, exp };
  if (oid !== undefined) claims.oid = oid;
  return claims;
}
