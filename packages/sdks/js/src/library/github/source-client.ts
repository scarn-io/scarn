/**
 * The private seam between `githubIssueImport`'s loop and the transport that
 * reaches GitHub. The MCP adapter implements it today; a REST adapter can be
 * added behind it without changing the loop.
 */
import type { GitHubIssue } from "./map-github-issue";

/** Where the next page starts. Opaque to the loop; only its adapter reads it. */
export type GitHubListCursor = string;

export type GitHubListPage = {
  /** Issues in ascending `updated_at` order. */
  readonly issues: readonly GitHubIssue[];
  /** The next page's cursor, or `null` when this page is the last. */
  readonly next: GitHubListCursor | null;
};

export type GitHubSourceClient = {
  /**
   * One page of `repo`'s (`owner/repo`) issues updated at or after `since`
   * (an ISO datetime), oldest first. Pass the previous page's `next` as
   * `cursor`.
   */
  readonly listIssuesUpdatedSince: (request: {
    readonly repo: string;
    readonly since: string;
    readonly cursor: GitHubListCursor | null;
  }) => Promise<GitHubListPage>;
};
