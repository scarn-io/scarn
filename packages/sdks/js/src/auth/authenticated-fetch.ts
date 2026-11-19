import type { ApiTokenSource, FetchLike } from "./api-token-source";

/**
 * Wraps `fetch` so every request carries the token source's `Authorization`.
 * A 401 on a request sent with a JWT invalidates that token and retries once
 * with a fresh one; the retry's response is returned as is. The retry uses a
 * clone taken before the first send, so request bodies can be resent.
 */
export function createAuthenticatedFetch(
  source: ApiTokenSource,
  options?: { fetch?: FetchLike | undefined },
): FetchLike {
  const fetchImpl: FetchLike = options?.fetch ?? ((...args) => fetch(...args));

  return async (input, init) => {
    const request = new Request(input, init);
    const retryRequest = request.clone();

    const credential = await source.getCredential();
    request.headers.set("Authorization", credential.authorization);
    const response = await fetchImpl(request);
    if (response.status !== 401 || credential.kind !== "jwt") return response;

    source.invalidate(credential.authorization);
    const retryCredential = await source.getCredential();
    retryRequest.headers.set("Authorization", retryCredential.authorization);
    return fetchImpl(retryRequest);
  };
}
