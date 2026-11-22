import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { UpsertWorkItemInput } from "@scarn/core/work-items/work-item/contracts/work-item-contracts";
import type { BitbucketRepoRef } from "@scarn/core/integrations/project-integration/domain/project-integration-entity";
import type { BitbucketClient } from "../infra/bitbucket-client";
import { mapBitbucketIssueToWorkItem } from "./map-bitbucket-issue-to-work-item";

export type IngestBitbucketIssuesInput = {
  projectId: UuidV7;
  repos: readonly BitbucketRepoRef[];
  /** Only issues updated after this instant; null fetches every issue. */
  sinceIso: string | null;
};

export type IngestBitbucketIssuesResult = {
  perRepo: Array<{
    fullName: string;
    totalSeen: number;
    totalUpserted: number;
  }>;
  totalUpserted: number;
  /** The latest `updated_on` seen across every repo, or null if none. */
  maxSourceUpdatedAt: string | null;
};

/** Pulls each repo's issues updated since `sinceIso` and upserts them. */
export const ingestBitbucketIssues = async (
  input: IngestBitbucketIssuesInput,
  client: Pick<BitbucketClient, "listIssues">,
  upsertWorkItems: (items: UpsertWorkItemInput[]) => Promise<unknown>,
): Promise<IngestBitbucketIssuesResult> => {
  const perRepo: IngestBitbucketIssuesResult["perRepo"] = [];
  let totalUpserted = 0;
  let maxSourceUpdatedAt: string | null = null;
  let maxSourceUpdatedAtMs = -Infinity;

  for (const repo of input.repos) {
    const issues = await client.listIssues(repo.workspace, repo.slug, {
      updatedSince: input.sinceIso,
    });

    for (const issue of issues) {
      const updatedAtMs = new Date(issue.updated_on).getTime();
      if (updatedAtMs > maxSourceUpdatedAtMs) {
        maxSourceUpdatedAtMs = updatedAtMs;
        maxSourceUpdatedAt = issue.updated_on;
      }
    }

    const workItems = issues.map((issue) =>
      mapBitbucketIssueToWorkItem({
        projectId: input.projectId,
        repoFullName: repo.fullName,
        issue,
      }),
    );
    if (workItems.length > 0) {
      await upsertWorkItems(workItems);
    }

    perRepo.push({
      fullName: repo.fullName,
      totalSeen: issues.length,
      totalUpserted: workItems.length,
    });
    totalUpserted += workItems.length;
  }

  return { perRepo, totalUpserted, maxSourceUpdatedAt };
};
