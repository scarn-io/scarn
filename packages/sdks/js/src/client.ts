import { ScarnClient } from "./generated";
import { createApiClient } from "./create-api-client";

export * from "./task-plane-client";
export * from "./generated/";

export type ScarnClientOptions = {
  /** Replaces `fetch` for every request, e.g. one from `createAuthenticatedFetch`. */
  fetch?:
    | ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>)
    | undefined;
};

export function createScarnClient(
  baseUrl: string,
  options?: ScarnClientOptions,
) {
  const client = createApiClient(baseUrl, { fetch: options?.fetch });
  return new ScarnClient({ client });
}
