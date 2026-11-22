const TRAILING_SLASHES_PATTERN = /\/+$/u;
const API_SUFFIX_PATTERN = /\/api$/u;
const HTTP_URL_PATTERN = /^https?:\/\//u;

/** Trims whitespace, trailing slashes and an `/api` suffix from a URL. */
export const stripScarnApiSuffix = (value: string): string =>
  value
    .trim()
    .replace(TRAILING_SLASHES_PATTERN, "")
    .replace(API_SUFFIX_PATTERN, "");

/**
 * Reduces a configured API URL to its origin (no trailing slash or `/api`
 * suffix). Returns undefined for empty or non-absolute values.
 */
export const normalizeScarnApiOrigin = (
  value: string | null | undefined,
): string | undefined => {
  const trimmed = value?.trim();
  if (!trimmed || !HTTP_URL_PATTERN.test(trimmed)) return undefined;
  return stripScarnApiSuffix(trimmed);
};

/** The API origin from `NEXT_PUBLIC_SCARN_API_URL`, if one is configured. */
export const getConfiguredPublicScarnApiOrigin = (): string | undefined =>
  normalizeScarnApiOrigin(process.env.NEXT_PUBLIC_SCARN_API_URL);

/**
 * URL of `path` under the API's `/api` mount. Absolute against the configured
 * API origin, or same-origin relative when none is configured, so server and
 * client renders agree.
 */
export const scarnApiUrl = (
  path: string,
  apiOrigin: string | undefined = getConfiguredPublicScarnApiOrigin(),
): string => `${apiOrigin ?? ""}/api${path}`;

/**
 * `GET /integrations/github/install` on the API. With `returnTo` it is the
 * create-a-project entry point, and the callback appends
 * `installation=connected` or `error=…` to `returnTo`; with `projectId` it
 * connects an existing project.
 */
export const githubInstallHref = (
  query: { returnTo: string } | { projectId: string },
): string =>
  `${scarnApiUrl("/integrations/github/install")}?${new URLSearchParams(query).toString()}`;
