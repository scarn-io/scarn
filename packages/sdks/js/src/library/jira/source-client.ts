/**
 * The private seam between `jiraIssueImport`'s loop and the transport that
 * reaches Jira. The MCP adapter implements it today; a REST adapter can be
 * added behind it, picked by `auth.type`, without changing the loop.
 */
import type { JiraIssue } from "./map-jira-issue";

/** Where the next page starts. Opaque to the loop; only its adapter reads it. */
export type JiraSearchCursor = string;

export type JiraSearchPage = {
  /** Issues in ascending `updated` order. */
  readonly issues: readonly JiraIssue[];
  /** The next page's cursor, or `null` when this page is the last. */
  readonly next: JiraSearchCursor | null;
};

export type JiraSourceClient = {
  /**
   * One page of `projectKey`'s issues updated at or after `since` (an ISO
   * datetime), oldest first. Pass the previous page's `next` as `cursor`.
   */
  readonly searchIssuesUpdatedSince: (request: {
    readonly projectKey: string;
    readonly since: string;
    readonly cursor: JiraSearchCursor | null;
  }) => Promise<JiraSearchPage>;
};
