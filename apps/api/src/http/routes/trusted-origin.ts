import { getBetterAuthTrustedOrigins } from "@scarn/identity";
import { CoreError } from "@scarn/core/lib/errors";

export const normalizeOrigin = (origin: string): string | null => {
  try {
    return new URL(origin).origin;
  } catch {
    return null;
  }
};

/** Better Auth's trusted origins, normalized to bare origins. */
export const getTrustedOrigins = (): string[] =>
  getBetterAuthTrustedOrigins()
    .map(normalizeOrigin)
    .filter((value): value is string => value !== null);

/**
 * A `beforeHandle` hook for mutating routes that hand out shared authority:
 * the request's `Origin` must be one of Better Auth's trusted origins. The
 * session cookie's `SameSite=Lax` already blocks cross-site writes; this also
 * blocks a sibling subdomain of the same site. A request without `Origin` is
 * rejected too.
 */
export const requireTrustedOrigin = ({
  request,
}: {
  request: Request;
}): void => {
  const origin = request.headers.get("origin");
  const normalized = origin === null ? null : normalizeOrigin(origin);
  if (normalized === null || !getTrustedOrigins().includes(normalized)) {
    throw new CoreError({
      code: "UNTRUSTED_ORIGIN",
      message: "This request must come from the Scarn app",
      status: 403,
    });
  }
};
