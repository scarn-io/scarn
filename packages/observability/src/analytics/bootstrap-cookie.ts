/**
 * Browser side of the share-link visitor id handoff. `GET /api/s/:code` mints
 * a PostHog distinct id for a first-time visitor and passes it along in a
 * short-lived cookie; `init()` reads it, bootstraps PostHog with it, and
 * deletes it. Pure string-in / string-out helpers so the contract is testable
 * without a browser.
 */

/**
 * Name of the handoff cookie. Must match `SHARE_LINK_BOOTSTRAP_COOKIE` in
 * `apps/api/src/http/routes/share-link-cookies.ts`, which this package cannot
 * import.
 */
export const BOOTSTRAP_COOKIE_NAME = "bb_ph_bootstrap";

export type BootstrapCookieRead = {
  present: boolean;
  distinctId: string | null;
};

const decode = (rawValue: string): string | null => {
  try {
    const decoded = decodeURIComponent(rawValue).trim();
    return decoded === "" ? null : decoded;
  } catch {
    return null;
  }
};

/**
 * Looks for the handoff cookie in a `document.cookie` string. `present` is
 * true whenever the cookie exists, even when its value is unusable, so the
 * caller can still delete it. `distinctId` is the first usable decoded value.
 */
export const readBootstrapCookie = (
  cookieString: string | null | undefined,
): BootstrapCookieRead => {
  let present = false;
  for (const pair of (cookieString ?? "").split(";")) {
    const separator = pair.indexOf("=");
    if (separator === -1) continue;
    if (pair.slice(0, separator).trim() !== BOOTSTRAP_COOKIE_NAME) continue;
    present = true;
    const distinctId = decode(pair.slice(separator + 1));
    if (distinctId !== null) return { present, distinctId };
  }
  return { present, distinctId: null };
};

/** Whether PostHog has already persisted an identity for `projectKey`. */
export const hasPosthogCookie = (
  cookieString: string | null | undefined,
  projectKey: string,
): boolean => {
  const wanted = `ph_${projectKey}_posthog`;
  return (cookieString ?? "")
    .split(";")
    .some((pair) => pair.split("=")[0]?.trim() === wanted);
};

const normalizeCookieDomain = (
  cookieDomain: string | null | undefined,
): string | null => {
  const normalized = cookieDomain?.trim().toLowerCase().replace(/^\./u, "");
  return normalized ? normalized : null;
};

const isWithinDomain = (hostname: string, domain: string): boolean =>
  hostname === domain || hostname.endsWith(`.${domain}`);

/**
 * The `document.cookie` assignment that expires the handoff cookie. It mirrors
 * how the server scoped it: `Domain=.<cookieDomain>` when a shared cookie
 * domain is configured and the page is on it, host-only otherwise (localhost,
 * preview deployments, installs without a shared domain), and `Secure` over
 * https.
 */
export const buildBootstrapCookieDeletion = ({
  hostname,
  protocol,
  cookieDomain,
}: {
  hostname: string;
  protocol: string;
  cookieDomain?: string | null;
}): string => {
  const domain = normalizeCookieDomain(cookieDomain);
  return [
    `${BOOTSTRAP_COOKIE_NAME}=`,
    ...(domain && isWithinDomain(hostname.toLowerCase(), domain)
      ? [`Domain=.${domain}`]
      : []),
    "Path=/",
    "Max-Age=0",
    ...(protocol === "https:" ? ["Secure"] : []),
    "SameSite=Lax",
  ].join("; ");
};
