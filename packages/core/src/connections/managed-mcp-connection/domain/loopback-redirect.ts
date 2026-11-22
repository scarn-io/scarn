import { CoreValidationError } from "@scarn/core/lib/errors";

/**
 * A redirect URI the CLI can catch on this machine (RFC 8252 §7.3): plain
 * `http` to `127.0.0.1`, `[::1]` or `localhost`, on any port and path, with no
 * userinfo and no fragment. The host must be written literally, so aliases the
 * URL parser would fold into `127.0.0.1` (such as `127.1`) are refused.
 */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  "127.0.0.1",
  "[::1]",
  "localhost",
]);

const AUTHORITY = /^http:\/\/([^/?#]*)/i;

const redirectInvalid = () =>
  new CoreValidationError(
    "The redirect URI must be http://127.0.0.1, http://[::1] or http://localhost, without userinfo or a fragment.",
    "MANAGED_CONNECTION_REDIRECT_INVALID",
  );

const hostOf = (authority: string): string =>
  authority.startsWith("[")
    ? authority.slice(0, authority.indexOf("]") + 1)
    : (authority.split(":")[0] ?? "");

const loopbackUrl = (uri: string): URL | null => {
  if (!URL.canParse(uri) || uri.includes("#")) {
    return null;
  }
  const url = new URL(uri);
  const authority = AUTHORITY.exec(uri)?.[1];
  if (
    url.protocol !== "http:" ||
    url.username ||
    url.password ||
    authority === undefined ||
    authority.includes("@") ||
    !LOOPBACK_HOSTS.has(url.hostname) ||
    hostOf(authority).toLowerCase() !== url.hostname
  ) {
    return null;
  }
  return url;
};

export const isLoopbackRedirectUri = (uri: string): boolean =>
  loopbackUrl(uri) !== null;

/**
 * Returns `uri` unchanged, since the token request must repeat it exactly.
 * Throws a 422 `MANAGED_CONNECTION_REDIRECT_INVALID` if it isn't loopback.
 */
export const parseLoopbackRedirectUri = (uri: string): string => {
  if (!loopbackUrl(uri)) {
    throw redirectInvalid();
  }
  return uri;
};
