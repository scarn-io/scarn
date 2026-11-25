import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import {
  fetchRepoIssues,
  splitRepoFullName,
  type GitHubIssue,
} from "../infra/github-issues-client";
import type { GitHubRateLimitSignal } from "../infra/github-rate-limit";
import { mapGitHubIssue } from "@scarn/sdk/library/github";
import type { UpsertWorkItemInput } from "@scarn/core/work-items/work-item/contracts/work-item-contracts";

export type RepoIngestResult = {
  fullName: string;
  totalSeen: number;
  totalUpserted: number;
  /**
   * The non-PR issues fetched for this repo, for
   * `ingestGitHubIssueRelationships` to build the GraphQL `parent`/
   * `blockedBy` relationships batch from.
   */
  issues: GitHubIssue[];
};

export type IngestGitHubIssuesResult = {
  perRepo: RepoIngestResult[];
  totalUpserted: number;
  /**
   * The max `updated_at` observed across every issue in every repo in this
   * run (not min, not per-repo), as an ISO string. `null` if zero issues were
   * seen across the entire run. Compared via `Date` (epoch ms), not
   * lexicographic string ordering, so the comparison stays correct even if a
   * caller passes strings that aren't uniformly-formatted ISO-8601 UTC.
   */
  maxSourceUpdatedAt: string | null;
};

export type IngestGitHubIssuesInput = {
  projectId: UuidV7;
  accessToken: string;
  repos: Array<{ fullName: string }>;
  sinceIso?: string | null;
  fetchImpl?: typeof fetch;
  rateLimitSignal?: GitHubRateLimitSignal;
};

export const ingestGitHubIssues = async (
  input: IngestGitHubIssuesInput,
  upsertWorkItems: (items: UpsertWorkItemInput[]) => Promise<unknown>,
): Promise<IngestGitHubIssuesResult> => {
  const perRepo: RepoIngestResult[] = [];
  let totalUpserted = 0;
  let maxSourceUpdatedAt: string | null = null;
  let maxSourceUpdatedAtMs = -Infinity;

  for (const repo of input.repos) {
    const { owner, repo: name } = splitRepoFullName(repo.fullName);
    const issues = await fetchRepoIssues({
      accessToken: input.accessToken,
      owner,
      repo: name,
      sinceIso: input.sinceIso ?? null,
      fetchImpl: input.fetchImpl,
      rateLimitSignal: input.rateLimitSignal,
    });

    for (const issue of issues) {
      const updatedAtMs = new Date(issue.updated_at).getTime();
      if (updatedAtMs > maxSourceUpdatedAtMs) {
        maxSourceUpdatedAtMs = updatedAtMs;
        maxSourceUpdatedAt = issue.updated_at;
      }
    }

    const issuesOnly = issues.filter((issue) => !issue.pull_request);
    const workItems: UpsertWorkItemInput[] = issuesOnly.map((issue) => ({
      projectId: input.projectId,
      ...mapGitHubIssue(issue, { repo: repo.fullName }),
    }));

    if (workItems.length > 0) {
      await upsertWorkItems(workItems);
    }

    perRepo.push({
      fullName: repo.fullName,
      totalSeen: issues.length,
      totalUpserted: workItems.length,
      issues: issuesOnly,
    });
    totalUpserted += workItems.length;
  }

  return { perRepo, totalUpserted, maxSourceUpdatedAt };
};
