import { getDomain } from "tldts";

/**
 * Whether bundle share links can be issued (plan decision 14: fail closed).
 * Sharing needs both the content origin (`SCARN_ARTIFACT_CONTENT_URL`, which
 * serves `/s/<token>/`) and the token secret (`ARTIFACT_SHARE_SECRET`); with
 * either unset, `enabled` is false and share links are unavailable.
 *
 * `contentUrl` is trimmed and has no trailing slash. `disabledReason` says why
 * sharing is off: `not_configured` when a setting is missing, and
 * `unsafe_content_origin` when the startup check
 * ({@link applyContentOriginIsolationCheck}) found the content host is not its
 * own site (decision 12).
 *
 * `contentOriginSecret` (`SCARN_ARTIFACT_CONTENT_ORIGIN_SECRET`) is the value
 * CloudFront puts in `X-Scarn-Content-Origin` on requests for the content
 * origin; see `classifyContentRequest`.
 */
export type ArtifactSharingDisabledReason =
  "not_configured" | "unsafe_content_origin";

export type ArtifactSharingConfig = {
  contentUrl: string | null;
  shareSecret: string | null;
  contentOriginSecret: string | null;
  enabled: boolean;
  disabledReason: ArtifactSharingDisabledReason | null;
};

export const ARTIFACT_SHARING_ENV_VARS = {
  contentUrl: "SCARN_ARTIFACT_CONTENT_URL",
  shareSecret: "ARTIFACT_SHARE_SECRET",
  contentOriginSecret: "SCARN_ARTIFACT_CONTENT_ORIGIN_SECRET",
} as const;

const blankToNull = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

export const createArtifactSharingConfig = (input: {
  contentUrl?: string | null | undefined;
  shareSecret?: string | null | undefined;
  contentOriginSecret?: string | null | undefined;
}): ArtifactSharingConfig => {
  const contentUrl = blankToNull(input.contentUrl?.trim().replace(/\/+$/, ""));
  const shareSecret = blankToNull(input.shareSecret);
  const enabled = contentUrl !== null && shareSecret !== null;
  return {
    contentUrl,
    shareSecret,
    contentOriginSecret: blankToNull(input.contentOriginSecret),
    enabled,
    disabledReason: enabled ? null : "not_configured",
  };
};

export const resolveArtifactSharingConfig = (
  env: Record<string, string | undefined> = {},
): ArtifactSharingConfig =>
  createArtifactSharingConfig({
    contentUrl: env[ARTIFACT_SHARING_ENV_VARS.contentUrl],
    shareSecret: env[ARTIFACT_SHARING_ENV_VARS.shareSecret],
    contentOriginSecret: env[ARTIFACT_SHARING_ENV_VARS.contentOriginSecret],
  });

/** The public URL of a share link: `${contentUrl}/s/<token>/`. */
export const artifactShareUrl = (contentUrl: string, token: string): string =>
  `${contentUrl}/s/${token}/`;

const LOOPBACK_IPS = new Set(["127.0.0.1", "[::1]"]);

/**
 * A host only reachable on this machine (`localhost`, `*.localhost`, a
 * loopback IP). Only these may serve the content origin over plain `http`.
 */
export const isLocalDevHost = (hostname: string): boolean =>
  hostname === "localhost" ||
  hostname.endsWith(".localhost") ||
  LOOPBACK_IPS.has(hostname);

const parseHttpUrl = (url: string | null | undefined): URL | null => {
  if (!url) {
    return null;
  }
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed
      : null;
  } catch {
    return null;
  }
};

/**
 * The registrable domain (eTLD+1) of a host, using the full public suffix
 * list including its private section, as browsers do when deciding what a
 * "site" is: `d111.cloudfront.net` and `d222.cloudfront.net` are different
 * sites. Hosts without one (`localhost`, IPs) are their own site.
 */
const siteOf = (hostname: string): string =>
  getDomain(hostname, { allowPrivateDomains: true }) ?? hostname;

/**
 * Plan decision 12 / ADR 0019: the content origin must be its own site, so
 * bundle code can never read or send the app's cookies. Returns the problems
 * found (empty when the host is safe). It rejects a content host that:
 * - is not an `http(s)` URL, or uses `http` on a non-local host;
 * - is the app or API host (ports are ignored: cookies ignore them too);
 * - is the cookie domain or under it (`BETTER_AUTH_COOKIE_DOMAIN`);
 * - shares a registrable domain (eTLD+1) with the app or API.
 *
 * Local dev: `localhost` has no registrable domain, so run the content origin
 * on another loopback name, e.g. `http://artifacts.localhost:3001` (browsers
 * resolve `*.localhost` to loopback) with the app on `http://localhost:3000`.
 * `localhost:3002` next to an app on `localhost:3000` is rejected: same host.
 */
export const checkContentOriginIsolation = (input: {
  contentUrl: string;
  appUrl: string | null;
  apiUrl: string | null;
  cookieDomain: string | null;
}): string[] => {
  const content = parseHttpUrl(input.contentUrl);
  if (!content) {
    return [`content URL "${input.contentUrl}" is not an http(s) URL`];
  }
  const host = content.hostname.toLowerCase();
  const problems: string[] = [];
  if (content.protocol === "http:" && !isLocalDevHost(host)) {
    problems.push(`content host "${host}" must use https`);
  }

  const others = [
    { name: "app", url: parseHttpUrl(input.appUrl) },
    { name: "API", url: parseHttpUrl(input.apiUrl) },
  ];
  for (const { name, url } of others) {
    if (!url) {
      continue;
    }
    const otherHost = url.hostname.toLowerCase();
    if (otherHost === host) {
      problems.push(`content host "${host}" is the ${name} host`);
    } else if (siteOf(otherHost) === siteOf(host)) {
      problems.push(
        `content host "${host}" shares the registrable domain "${siteOf(host)}" with the ${name} host "${otherHost}"`,
      );
    }
  }

  const cookieDomain = input.cookieDomain
    ?.trim()
    .replace(/^\./, "")
    .toLowerCase();
  if (
    cookieDomain &&
    (host === cookieDomain || host.endsWith(`.${cookieDomain}`))
  ) {
    problems.push(
      `content host "${host}" is inside the auth cookie domain "${cookieDomain}"`,
    );
  }
  return problems;
};

/**
 * The startup check: when sharing is enabled but the content origin is not
 * isolated, sharing is turned off (`unsafe_content_origin`) instead of
 * crashing the API, and `onUnsafe` is told why so it can log loudly.
 */
export const applyContentOriginIsolationCheck = (
  config: ArtifactSharingConfig,
  context: {
    appUrl: string | null;
    apiUrl: string | null;
    cookieDomain: string | null;
  },
  onUnsafe: (problems: string[]) => void = () => {},
): ArtifactSharingConfig => {
  if (!config.enabled || !config.contentUrl) {
    return config;
  }
  const problems = checkContentOriginIsolation({
    contentUrl: config.contentUrl,
    ...context,
  });
  if (problems.length === 0) {
    return config;
  }
  onUnsafe(problems);
  return { ...config, enabled: false, disabledReason: "unsafe_content_origin" };
};
