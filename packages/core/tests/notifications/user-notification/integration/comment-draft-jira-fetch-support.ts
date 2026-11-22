/**
 * Shared `mock.module` harness for `work-item-comment-draft.approve-jira*
 * .test.ts` — swaps out `@/integrations/jira-ingest/infra/jira-comment
 * -client`'s `postJiraIssueComment` export for a canned resolve/reject
 * implementation, so `approveCommentDraft`'s Jira branch can be exercised
 * end-to-end through the real API without ever making a real network call
 * to Jira.
 *
 * GitHub's comment tests fake `globalThis.fetch` instead (see
 * `comment-draft-github-fetch-support.ts`); here `mock.module` substitutes
 * the whole outbound infra function, the same pattern
 * `ingest-jira-issues.test.ts` uses for a neighboring Jira module.
 *
 * Re-exports the *real* `JiraCommentError` unchanged —
 * only `postJiraIssueComment` itself is replaced — so `instanceof
 * JiraCommentError` checks in `approve-comment-draft.ts`'s catch block keep
 * working against the same class identity.
 *
 * `mock.module` mutates global module resolution for the rest of the
 * process — and, critically, `mock.restore()` does NOT undo it (that only
 * resets spies created via `mock()`, not `mock.module` substitutions). Every
 * file using this must run its tests serially (plain `test`, not
 * `test.concurrent`) AND call `uninstallJiraCommentClientMock()` in
 * `afterEach` to put the real module back; skipping that leaves
 * `jira-comment-client` permanently stubbed out for every test file that
 * runs afterward in the same `bun test` process — including, concretely,
 * `jira-comment-client.test.ts`'s own unit coverage of the real
 * catch-and-wrap logic, which would otherwise see this mock's canned
 * resolve/reject instead.
 */

import { mock } from "bun:test";
import type { AdfDocument } from "@/integrations/jira-ingest/infra/markdown-to-adf";
import {
  JiraCommentError,
  postJiraIssueComment,
} from "@/integrations/jira-ingest/infra/jira-comment-client";

// A plain (non-live-binding) snapshot of the real `postJiraIssueComment`,
// captured at module-load time, before `installJiraCommentClientMock` ever
// runs. This matters because `mock.module` mutates the target module's
// export bindings in place: an ES `import { x }` is a *live* view onto that
// binding, so `postJiraIssueComment` above would itself start resolving to
// the mock the moment `installJiraCommentClientMock` is called, taking any
// "restore" attempt built directly on that import down with it. Assigning it
// to a plain `const` here, before any mocking happens, copies the function
// reference into an ordinary variable that mock.module can no longer reach.
const REAL_POST_JIRA_ISSUE_COMMENT = postJiraIssueComment;

export type CapturedPostJiraIssueCommentCall = {
  baseUrl: string;
  email: string;
  apiToken: string;
  issueKey: string;
  document: AdfDocument;
};

export type InstallJiraCommentClientMockOptions = {
  /** When `true`, the mocked `postJiraIssueComment` rejects with a
   * `JiraCommentError` instead of resolving. */
  shouldFail?: boolean;
  /** `JiraCommentError.status` used on the rejection path. Defaults to 401,
   * mimicking a bad/expired Jira API key. */
  failureStatus?: number;
  /** Fails only the first this-many calls, then succeeds. */
  failTimes?: number;
};

/** Canned failure message used whenever `shouldFail` is set — deliberately
 * built without any reference to the caller's `apiToken`/`email`, mirroring
 * the real `postJiraIssueComment`'s own message-hygiene guarantee (Decision
 * 8 in `docs/plans/jira-comment-approval.md`), so tests asserting that
 * guarantee against this mock stay meaningful. */
export const JIRA_COMMENT_POST_FAILURE_MESSAGE =
  "Jira returned 401 posting a comment: Unauthorized";

/** Canned successful post result. */
export const MOCKED_JIRA_COMMENT_ID = "98765";

const buildMockedUrl = (baseUrl: string, issueKey: string): string =>
  `${baseUrl.replace(/\/$/, "")}/browse/${issueKey}?focusedCommentId=${MOCKED_JIRA_COMMENT_ID}`;

/**
 * Registers the `mock.module` override for `jira-comment-client`. Must be
 * called (and `await`ed) before any code path that imports
 * `approveCommentDraft` (directly or transitively, e.g. via `createApp`) is
 * itself imported — callers should follow with a dynamic `await
 * import(...)` of `createApp`/`createAppContext`, mirroring
 * `ingest-jira-issues.test.ts`'s ordering.
 *
 * Returns the array `postJiraIssueComment` will push every call's input
 * onto, so callers can assert which integration's `baseUrl`/`email` a given
 * approve request actually resolved to and used (see
 * `work-item-comment-draft.approve-jira-integration-resolution.test.ts`).
 */
export const installJiraCommentClientMock = async (
  options: InstallJiraCommentClientMockOptions = {},
): Promise<{ calls: CapturedPostJiraIssueCommentCall[] }> => {
  const { shouldFail = false, failureStatus = 401, failTimes = 0 } = options;
  const calls: CapturedPostJiraIssueCommentCall[] = [];

  await mock.module(
    "@/integrations/jira-ingest/infra/jira-comment-client",
    () => ({
      JiraCommentError,
      postJiraIssueComment: mock((input: CapturedPostJiraIssueCommentCall) => {
        calls.push(input);
        if (shouldFail || calls.length <= failTimes) {
          return Promise.reject(
            new JiraCommentError(
              JIRA_COMMENT_POST_FAILURE_MESSAGE,
              failureStatus,
            ),
          );
        }
        return Promise.resolve({
          id: MOCKED_JIRA_COMMENT_ID,
          url: buildMockedUrl(input.baseUrl, input.issueKey),
        });
      }),
    }),
  );

  return { calls };
};

/**
 * Puts the real `jira-comment-client` module back, undoing
 * `installJiraCommentClientMock`. Must be awaited in every consuming test
 * file's `afterEach` — `mock.restore()` alone does not reverse a
 * `mock.module` substitution (see the module doc comment above).
 */
export const uninstallJiraCommentClientMock = async (): Promise<void> => {
  await mock.module(
    "@/integrations/jira-ingest/infra/jira-comment-client",
    () => ({
      JiraCommentError,
      postJiraIssueComment: REAL_POST_JIRA_ISSUE_COMMENT,
    }),
  );
};
