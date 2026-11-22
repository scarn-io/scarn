import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { UpsertWorkItemInput } from "@scarn/core/work-items/work-item/contracts/work-item-contracts";
import type { GitHubIssue } from "../infra/github-issues-client";

const normalizeLabels = (labels: GitHubIssue["labels"]): string[] => {
  if (!labels) return [];
  const names: string[] = [];
  for (const label of labels) {
    if (typeof label === "string") {
      names.push(label);
    } else if (label.name) {
      names.push(label.name);
    }
  }
  return names;
};

const normalizeAssignees = (assignees: GitHubIssue["assignees"]): string[] => {
  if (!assignees) return [];
  return assignees
    .map((assignee) => assignee.login)
    .filter((login): login is string => Boolean(login));
};

export const mapGitHubIssueToWorkItem = ({
  projectId,
  repoFullName,
  issue,
}: {
  projectId: UuidV7;
  repoFullName: string;
  issue: GitHubIssue;
}): UpsertWorkItemInput => {
  const description =
    issue.body && issue.body.trim().length > 0
      ? issue.body
      : "(No description provided.)";

  return {
    projectId,
    platform: "github",
    platformId: issue.node_id,
    platformKey: `${repoFullName}#${String(issue.number)}`,
    url: issue.html_url,
    title: issue.title,
    description,
    sourceCreatedAt: issue.created_at,
    sourceUpdatedAt: issue.updated_at,
    state: issue.state === "closed" ? "closed" : "open",
    labels: normalizeLabels(issue.labels),
    fields: {
      repository: repoFullName,
      number: issue.number,
      state: issue.state,
      stateReason: issue.state_reason ?? null,
      author: issue.user?.login ?? null,
      assignees: normalizeAssignees(issue.assignees),
      commentsCount: issue.comments ?? 0,
      closedAt: issue.closed_at ?? null,
    },
  };
};
