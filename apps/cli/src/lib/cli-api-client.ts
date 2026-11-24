import {
  createApiTokenSource,
  createAuthenticatedFetch,
  type FetchLike,
} from "@scarn/sdk/auth";
import { createScarnClient } from "@scarn/sdk/client";
import { loadAuthenticatedSession } from "@scarn/worker";

/**
 * The two things a CLI adapter that talks to the API needs: an authenticated
 * client, and a way to turn the server's error body into a sentence.
 *
 * Requests carry short-lived API tokens minted from the profile's session token
 * (see `@scarn/sdk/auth`), so callers pass no `Authorization` header. Kept
 * separate from the adapters themselves so they stay thin. `pipelines push`
 * (which hands the session token to its push script) and `auth` (which reports
 * the session itself) call `loadAuthenticatedSession` directly.
 */

export type AuthenticatedApi = {
  client: ReturnType<typeof createScarnClient>;
  /**
   * The fetch behind `client`, for the SDK's hand-written clients
   * (`createPipelineDefinitionsClient`, `createAutomationsClient`).
   */
  fetch: FetchLike;
};

/** An authenticated client for `baseUrl`, or a throw naming the fix. */
export async function connectApi(baseUrl: string): Promise<AuthenticatedApi> {
  const authenticated = await loadAuthenticatedSession(baseUrl);
  if (!authenticated) {
    throw new Error(
      `Not signed in to ${baseUrl}. Run \`scarn auth login\` first.`,
    );
  }
  const fetch = createAuthenticatedFetch(
    createApiTokenSource({
      baseUrl,
      getSessionToken: () => authenticated.profile.accessToken,
    }),
  );
  return { client: createScarnClient(baseUrl, { fetch }), fetch };
}

type ApiFieldIssue = { path?: string; message?: string };

/**
 * The API's error bodies are RFC 7807 Problem Details (see
 * `apiErrorResponseSchema`), so `detail` is the sentence written for a human and
 * `title` the short fallback. Both beat `JSON.stringify`, which puts a brace
 * salad in front of the user. A validation failure's per-field `errors` are
 * appended, since its `detail` alone doesn't say which field was rejected.
 */
export function describeApiError(error: {
  title?: string | undefined;
  detail?: string | undefined;
  errors?: readonly ApiFieldIssue[] | undefined;
}): string {
  const summary =
    error.detail ?? error.title ?? "the server rejected the request";
  const issues = (error.errors ?? []).flatMap(({ path, message }) => {
    if (message === undefined) return [];
    return path === undefined || path === "" || path === "/"
      ? [message]
      : [`${path}: ${message}`];
  });
  return issues.length === 0 ? summary : `${summary} (${issues.join("; ")})`;
}
