/**
 * `@scarn/sdk/library/github`: import GitHub issues into a project as work
 * items from a scheduled code step.
 */
export {
  githubIssueImport,
  type GitHubIssueImportOptions,
  type GitHubIssueImportScheduleOptions,
  type GitHubIssueImportStep,
} from "./github-issue-import";
export type { GitHubAuth } from "./auth";
export {
  mapGitHubIssue,
  type GitHubIssue,
  type GitHubWorkItem,
  type MapGitHubIssueOptions,
} from "./map-github-issue";
