import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { UpsertWorkItemInput } from "@scarn/core/work-items/work-item/contracts/work-item-contracts";
import type { WorkItemState } from "@scarn/core/work-items/work-item/domain/work-item-state";
import type { BitbucketIssue } from "../infra/bitbucket-client";

const OPEN_BITBUCKET_STATES = new Set(["new", "open", "on hold"]);

/**
 * Bitbucket's `new`, `open` and `on hold` are still to be worked on; every
 * other state (`resolved`, `closed`, `invalid`, `duplicate`, `wontfix`) ends
 * the issue.
 */
export const bitbucketStateToWorkItemState = (state: string): WorkItemState =>
  OPEN_BITBUCKET_STATES.has(state.toLowerCase()) ? "open" : "closed";

export const mapBitbucketIssueToWorkItem = ({
  projectId,
  repoFullName,
  issue,
}: {
  projectId: UuidV7;
  repoFullName: string;
  issue: BitbucketIssue;
}): UpsertWorkItemInput => {
  const raw = issue.content?.raw ?? "";
  const platformKey = `${repoFullName}#${String(issue.id)}`;

  return {
    projectId,
    platform: "bitbucket",
    platformId: platformKey,
    platformKey,
    url:
      issue.links?.html?.href ??
      `https://bitbucket.org/${repoFullName}/issues/${String(issue.id)}`,
    title: issue.title,
    description: raw.trim().length > 0 ? raw : "(No description provided.)",
    sourceCreatedAt: issue.created_on,
    sourceUpdatedAt: issue.updated_on,
    state: bitbucketStateToWorkItemState(issue.state),
    fields: {
      repository: repoFullName,
      number: issue.id,
      state: issue.state,
      kind: issue.kind ?? null,
      priority: issue.priority ?? null,
      reporter: issue.reporter?.display_name ?? null,
      assignee: issue.assignee?.display_name ?? null,
      votes: issue.votes ?? 0,
    },
  };
};
