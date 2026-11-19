import { createClient } from "./generated/client";

/**
 * The generated `createClient`, configured so that an error thrown by `fetch`
 * itself (a failed token mint, a network error) fails the call as is instead of
 * being folded into `{ error: {} }`. Errors carried by a response are left to
 * the caller as usual.
 */
export function createApiClient(
  baseUrl: string,
  options?: {
    headers?: Record<string, string> | undefined;
    fetch?:
      | ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>)
      | undefined;
  },
): ReturnType<typeof createClient> {
  const client = createClient({
    baseUrl,
    headers: options?.headers,
    fetch: options?.fetch as typeof fetch | undefined,
  });
  client.interceptors.error.use((error, response: Response | undefined) => {
    if (response === undefined) throw error;
    return error;
  });
  return client;
}
