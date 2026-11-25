/**
 * `mapGitHubIssue`: one GitHub issue (a REST issue, a webhook payload's
 * `issue`, or a `list_issues` item from GitHub's MCP server) to a work item.
 * Shared by the server's GitHub App sync and `githubIssueImport`, so both
 * write the same item for the same issue.
 */
import { z } from "zod";

const loginSchema = z.object({ login: z.string().nullish() });

/**
 * The parts of an issue the mapper reads, in either shape: REST
 * (`state: "open"`, label and user objects, `node_id`, `html_url`) or
 * `list_issues` (`state: "OPEN"`, label names and logins, no `node_id`,
 * `html_url`, `state_reason` or `closed_at`).
 */
export const gitHubIssueSchema = z.looseObject({
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string().nullish(),
  state: z.string(),
  node_id: z.string().nullish(),
  html_url: z.string().nullish(),
  state_reason: z.string().nullish(),
  user: loginSchema.nullish(),
  labels: z
    .array(z.union([z.string(), z.object({ name: z.string().nullish() })]))
    .nullish(),
  assignees: z.array(z.union([z.string(), loginSchema])).nullish(),
  comments: z.number().nullish(),
  created_at: z.string(),
  updated_at: z.string(),
  closed_at: z.string().nullish(),
  pull_request: z.unknown().optional(),
});
export type GitHubIssue = z.input<typeof gitHubIssueSchema>;

export type MapGitHubIssueOptions = {
  /** The issue's repository, `owner/repo`. */
  readonly repo: string;
};

/**
 * The work item for one issue. It fits both the step bridge's upsert item
 * and the server's upsert input (with a `projectId`). `platformId` (the
 * issue's GraphQL node id) is left out when the source doesn't give it, so
 * the stored one is kept.
 */
export type GitHubWorkItem = {
  platform: "github";
  platformId?: string;
  platformKey: string;
  url: string;
  title: string;
  description: string;
  sourceCreatedAt: string;
  sourceUpdatedAt: string;
  state: "open" | "closed";
  labels: string[];
  fields: {
    repository: string;
    number: number;
    state: string;
    stateReason: string | null;
    author: string | null;
    assignees: string[];
    commentsCount: number;
    closedAt: string | null;
  };
};

const NO_DESCRIPTION = "(No description provided.)";

function labelNames(labels: GitHubIssue["labels"]): string[] {
  const names: string[] = [];
  for (const label of labels ?? []) {
    const name = typeof label === "string" ? label : label.name;
    if (name) names.push(name);
  }
  return names;
}

function assigneeLogins(assignees: GitHubIssue["assignees"]): string[] {
  const logins: string[] = [];
  for (const assignee of assignees ?? []) {
    const login = typeof assignee === "string" ? assignee : assignee.login;
    if (login) logins.push(login);
  }
  return logins;
}

/** Maps one GitHub issue to its work item, keyed `owner/repo#number`. */
export function mapGitHubIssue(
  issue: GitHubIssue,
  options: MapGitHubIssueOptions,
): GitHubWorkItem {
  const state = issue.state.toLowerCase();
  return {
    platform: "github",
    ...(issue.node_id ? { platformId: issue.node_id } : {}),
    platformKey: `${options.repo}#${String(issue.number)}`,
    url:
      issue.html_url ??
      `https://github.com/${options.repo}/issues/${String(issue.number)}`,
    title: issue.title,
    description:
      issue.body && issue.body.trim().length > 0 ? issue.body : NO_DESCRIPTION,
    sourceCreatedAt: issue.created_at,
    sourceUpdatedAt: issue.updated_at,
    state: state === "closed" ? "closed" : "open",
    labels: labelNames(issue.labels),
    fields: {
      repository: options.repo,
      number: issue.number,
      state,
      stateReason: issue.state_reason ?? null,
      author: issue.user?.login ?? null,
      assignees: assigneeLogins(issue.assignees),
      commentsCount: issue.comments ?? 0,
      closedAt: issue.closed_at ?? null,
    },
  };
}
