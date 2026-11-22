/**
 * Shared fake `globalThis.fetch` for `work-item-comment-draft.approve*
 * .test.ts` — mints a canned installation token, then serves (or fails) the
 * outbound "post a comment" call `approveCommentDraft` makes via
 * `postIssueComment`. Mirrors the request-matching style of
 * `run-project-integration-sync-relationships-test-support.ts`'s
 * `makeRelationshipsFetchImpl` (`url.includes(...)` dispatch), but this
 * suite's own outbound calls are different endpoints (mint-token +
 * issue-comment-post rather than issue-list/GraphQL), so it isn't reused
 * directly.
 *
 * Mutates `globalThis.fetch` — any test file using this must run serially
 * (plain `test`, not `concurrentTest`) — see the two `approve*.test.ts` files
 * for the exact precedent this follows
 * (`run-project-integration-sync.relationships.test.ts`).
 */

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

const jsonResponse = (body: JsonValue, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const toRequestUrl = (input: string | URL | Request): string =>
  typeof input === "string"
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url;

export type CommentDraftFetchOpts = {
  owner: string;
  repo: string;
  issueNumber: number;
  /** When `true`, the "post a comment" call resolves to a non-2xx response
   * (401, mimicking a bad/expired installation token) instead of succeeding.
   * The mint-token call always succeeds regardless. */
  commentPostShouldFail?: boolean;
};

export const COMMENT_POST_FAILURE_MESSAGE = "Bad credentials";

export const makeCommentDraftFetchImpl = (
  opts: CommentDraftFetchOpts,
): typeof fetch => {
  return ((input: string | URL | Request) => {
    const url = toRequestUrl(input);

    if (url.includes("/access_tokens")) {
      return Promise.resolve(
        jsonResponse({
          token: "installation-token",
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
        }),
      );
    }

    // `/issues/:number/comments` — matching `.includes("/comments")` is
    // sufficient and won't collide with the access_tokens URL.
    if (url.includes("/comments")) {
      if (opts.commentPostShouldFail) {
        return Promise.resolve(
          jsonResponse({ message: COMMENT_POST_FAILURE_MESSAGE }, 401),
        );
      }
      return Promise.resolve(
        jsonResponse({
          id: 12345,
          html_url: `https://github.com/${opts.owner}/${opts.repo}/issues/${String(opts.issueNumber)}#issuecomment-12345`,
        }),
      );
    }

    throw new Error(`Unexpected fetch to ${url}`);
  }) as unknown as typeof fetch;
};
