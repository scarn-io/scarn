/**
 * Shared plumbing for calling the Jira Cloud REST API with `fetch`: basic
 * auth from an account email + API token, and a JSON request helper. The
 * Authorization header is built here and never appears in errors or logs.
 */

export type JiraConnectionInput = {
  baseUrl: string;
  email: string;
  apiToken: string;
};

export type JiraFetchOptions = JiraConnectionInput & {
  fetchImpl?: typeof fetch;
};

export const trimJiraBaseUrl = (baseUrl: string): string =>
  baseUrl.replace(/\/+$/, "");

export const jiraBasicAuth = (input: JiraConnectionInput): string =>
  `Basic ${Buffer.from(`${input.email}:${input.apiToken}`).toString("base64")}`;

export const isJiraTimeout = (
  // Receives whatever a `catch` clause caught; there is no narrower type.
  // eslint-disable-next-line local/no-unknown-parameter-type
  error: unknown,
): boolean =>
  error instanceof Error &&
  (error.name === "TimeoutError" || error.name === "AbortError");

/** A non-2xx Jira response: its status and raw body text. */
export type JiraHttpFailure = { status: number; body: string };

export type JiraJsonResult =
  | { ok: true; status: number; json: unknown }
  | ({ ok: false } & JiraHttpFailure);

/**
 * Sends a JSON request to `{baseUrl}{path}` and returns the parsed body, or
 * the status and body text when Jira answers with a non-2xx status. Network
 * errors and timeouts propagate to the caller.
 */
export const jiraJsonRequest = async (
  input: JiraFetchOptions,
  path: string,
  options: { method?: "GET" | "POST"; body?: object; timeoutMs?: number } = {},
): Promise<JiraJsonResult> => {
  const fetchImpl = input.fetchImpl ?? fetch;
  const headers: Record<string, string> = {
    authorization: jiraBasicAuth(input),
    accept: "application/json",
  };
  if (options.body !== undefined) headers["content-type"] = "application/json";

  const response = await fetchImpl(`${trimJiraBaseUrl(input.baseUrl)}${path}`, {
    method: options.method ?? "GET",
    headers,
    ...(options.body !== undefined
      ? { body: JSON.stringify(options.body) }
      : {}),
    ...(options.timeoutMs !== undefined
      ? { signal: AbortSignal.timeout(options.timeoutMs) }
      : {}),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    return { ok: false, status: response.status, body };
  }
  return { ok: true, status: response.status, json: await response.json() };
};
