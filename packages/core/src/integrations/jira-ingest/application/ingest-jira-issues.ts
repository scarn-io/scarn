import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { UpsertWorkItemInput } from "@scarn/core/work-items/work-item/contracts/work-item-contracts";
import {
  fetchJiraIssues,
  fetchJiraFieldNameMap,
  fetchJiraAccountTimeZone,
} from "../infra/jira-issues-client";
import { mapJiraIssue } from "@scarn/sdk/library/jira";

export type JiraProjectIngestResult = {
  key: string;
  totalSeen: number;
  totalUpserted: number;
};

export type IngestJiraIssuesResult = {
  perProject: JiraProjectIngestResult[];
  totalUpserted: number;
};

export type IngestJiraIssuesInput = {
  projectId: UuidV7;
  baseUrl: string;
  email: string;
  apiToken: string;
  projectKeys: string[];
  sinceIso?: string | null;
};

export const ingestJiraIssues = async (
  input: IngestJiraIssuesInput,
  upsertWorkItems: (items: UpsertWorkItemInput[]) => Promise<unknown>,
): Promise<IngestJiraIssuesResult> => {
  const perProject: JiraProjectIngestResult[] = [];
  let totalUpserted = 0;

  const fieldNameMap = await fetchJiraFieldNameMap({
    baseUrl: input.baseUrl,
    email: input.email,
    apiToken: input.apiToken,
  });

  // Resolved once per run (not per project key) since it's the same Jira
  // account for every project in this integration. Only needed when
  // filtering by `since` — see `fetchJiraAccountTimeZone` for why Jira's
  // account timezone (not UTC) governs how the JQL date literal is parsed.
  const timeZone = input.sinceIso
    ? await fetchJiraAccountTimeZone({
        baseUrl: input.baseUrl,
        email: input.email,
        apiToken: input.apiToken,
      })
    : undefined;

  for (const projectKey of input.projectKeys) {
    const issues = await fetchJiraIssues({
      baseUrl: input.baseUrl,
      email: input.email,
      apiToken: input.apiToken,
      projectKey,
      sinceIso: input.sinceIso ?? null,
      timeZone,
    });

    const workItems = issues.map((issue): UpsertWorkItemInput => {
      const item = mapJiraIssue(issue, {
        site: input.baseUrl,
        fieldNames: fieldNameMap,
      });
      return {
        ...item,
        projectId: input.projectId,
        fields: { commentsCount: 0, ...item.fields },
      };
    });

    if (workItems.length > 0) {
      await upsertWorkItems(workItems);
    }

    perProject.push({
      key: projectKey,
      totalSeen: issues.length,
      totalUpserted: workItems.length,
    });
    totalUpserted += workItems.length;
  }

  return { perProject, totalUpserted };
};
