import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import {
  upsertWorkItems,
  type UpsertWorkItemsDeps,
} from "@scarn/core/work-items/work-item/application/upsert-work-item";
import type { GitHubIssue } from "../infra/github-issues-client";
import { mapGitHubIssueToWorkItem } from "./map-github-issue-to-work-item";

export type UpsertWorkItemFromGitHubIssueWebhookInput = {
  projectId: UuidV7;
  repoFullName: string;
  issue: GitHubIssue;
};

export type UpsertWorkItemFromGitHubIssueWebhookDeps = UpsertWorkItemsDeps;

export type UpsertWorkItemFromGitHubIssueWebhookResult = {
  /**
   * `false` when the delivery was an idempotent no-op — the atomic
   * `sourceUpdatedAt` guard in `WorkItemRepo.saveManyIfSourceNewer` rejected
   * it as not newer than what's already stored (decisions 6/12,
   * docs/plans/github-integration-sync-scaling.md). Never an error case.
   */
  applied: boolean;
};

/**
 * Webhook counterpart to `ingestGitHubIssues`'s poll-path upsert: maps a
 * single `issues.*` webhook payload straight to a work-item upsert with zero
 * follow-up GitHub API calls (decision 5) — the webhook payload's `issue`
 * already carries title/state/labels/assignees. Shares
 * `mapGitHubIssueToWorkItem` with the poll path so the two mappings can never
 * drift apart, and persists through the same front door, `upsertWorkItems`,
 * so parent preservation and default pipeline assignment are shared too.
 *
 * Idempotency (decisions 6, 12): the upsert runs with `onlyIfSourceNewer`,
 * which persists through `workItemRepo.saveManyIfSourceNewer`, whose `ON
 * CONFLICT ... DO UPDATE` carries an atomic `WHERE excluded.source_updated_at
 * > work_items.source_updated_at` guard. An out-of-order/stale delivery (an
 * `updated_at` no newer than what's already stored) is silently a no-op
 * (`applied: false`) — never a read-compare-write, so concurrent/at-least-once
 * webhook deliveries can't race each other into overwriting a newer value.
 *
 * Deliberately does **not** run `ingestGitHubIssueRelationships` — a
 * labeled/edited event that touches a task-list or sub-issue reference still
 * only updates this one work item's own fields; relationship resolution stays
 * on the reconcile sweep's pending-refs backlog (Phase 3), not a synchronous
 * webhook call.
 */
export const upsertWorkItemFromGitHubIssueWebhook = async (
  input: UpsertWorkItemFromGitHubIssueWebhookInput,
  deps: UpsertWorkItemFromGitHubIssueWebhookDeps,
): Promise<UpsertWorkItemFromGitHubIssueWebhookResult> => {
  const mapped = mapGitHubIssueToWorkItem({
    projectId: input.projectId,
    repoFullName: input.repoFullName,
    issue: input.issue,
  });

  const saved = await upsertWorkItems([mapped], deps, {
    onlyIfSourceNewer: true,
  });

  return { applied: saved.length > 0 };
};
