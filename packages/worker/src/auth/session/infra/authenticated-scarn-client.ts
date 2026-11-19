import { createScarnClient } from "@scarn/sdk";
import {
  createApiTokenSource,
  createAuthenticatedFetch,
} from "@scarn/sdk/auth";

/**
 * A Scarn API client whose requests carry short-lived API tokens minted from
 * `accessToken` (the session token), refreshed and retried once on a 401.
 */
export function createAuthenticatedScarnClient(
  baseUrl: string,
  accessToken: string,
): ReturnType<typeof createScarnClient> {
  return createScarnClient(baseUrl, {
    fetch: createAuthenticatedFetch(
      createApiTokenSource({ baseUrl, getSessionToken: () => accessToken }),
    ),
  });
}
