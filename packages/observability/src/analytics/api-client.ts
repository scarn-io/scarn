/**
 * Labels which first-party client sent an API request, so per-request
 * analytics (`api_endpoint_timed`) can be broken down by surface. Clients send
 * the headers built by {@link apiClientHeaders}; the API reads them back with
 * {@link readApiClient}. The label is self-reported and spoofable: use it for
 * analytics only, never for authorization.
 */

export const API_CLIENT_HEADER = "x-scarn-client";
export const API_CLIENT_VERSION_HEADER = "x-scarn-client-version";

export const API_CLIENT_NAMES = ["cli", "web"] as const;

export type ApiClientName = (typeof API_CLIENT_NAMES)[number];

export type ApiClientProperties = {
  client: ApiClientName | "unknown";
  client_version?: string;
};

const MAX_VERSION_LENGTH = 64;
const VERSION_PATTERN = /^[0-9A-Za-z.+-]+$/;

const isApiClientName = (value: string): value is ApiClientName =>
  (API_CLIENT_NAMES as readonly string[]).includes(value);

export function apiClientHeaders(
  client: ApiClientName,
  version?: string,
): Record<string, string> {
  return version
    ? { [API_CLIENT_HEADER]: client, [API_CLIENT_VERSION_HEADER]: version }
    : { [API_CLIENT_HEADER]: client };
}

/**
 * The client label on `headers`, or `unknown` when it is missing or not a
 * known client. A version is kept only alongside a known client and only when
 * it looks like a version string, so arbitrary header values never reach
 * PostHog.
 */
export function readApiClient(headers: Headers): ApiClientProperties {
  const client = headers.get(API_CLIENT_HEADER)?.trim().toLowerCase();
  if (!client || !isApiClientName(client)) return { client: "unknown" };

  const version = headers.get(API_CLIENT_VERSION_HEADER)?.trim();
  return version &&
    version.length <= MAX_VERSION_LENGTH &&
    VERSION_PATTERN.test(version)
    ? { client, client_version: version }
    : { client };
}
