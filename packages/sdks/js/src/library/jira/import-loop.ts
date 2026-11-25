/**
 * `jiraIssueImport`'s loop: per project key, resume from the newest stored
 * `sourceUpdatedAt` under `<KEY>-` (minus an overlap), page through the
 * source oldest first, and upsert page by page. Every saved page is older
 * than every unsaved one, so a crash or failure never moves the cursor past
 * an issue that wasn't saved. It only sees the `JiraSourceClient`.
 */
import { MAX_WORK_ITEM_UPSERTS } from "../../contracts/step-bridge";
import type {
  WorkItemsLatestSourceUpdate,
  WorkItemsUpsert,
} from "../../definitions/steps/code-step-work-items-client";
import { StepError } from "../../definitions/steps/step-error";
import { mapJiraIssue, type JiraIssue } from "./map-jira-issue";
import type { JiraSourceClient } from "./source-client";

/** Re-read this much before the cursor: equal timestamps and minute-precision JQL. */
export const JIRA_CURSOR_OVERLAP_MS = 5 * 60_000;
export const DEFAULT_FIRST_SYNC_HORIZON_DAYS = 30;
/** A run that pages more than this is stuck, not busy. */
const MAX_PAGES_PER_PROJECT = 10_000;

export type JiraProjectImportResult = {
  projectKey: string;
  /** Issues the source returned, counting any it returned twice. */
  seen: number;
  /** Items created or updated; unchanged ones aren't counted. */
  upserted: number;
};

export type JiraImportResult = {
  upserted: number;
  projects: JiraProjectImportResult[];
};

export type JiraImportOptions = {
  readonly source: JiraSourceClient;
  readonly workItems: {
    readonly upsert: WorkItemsUpsert;
    readonly latestSourceUpdate: WorkItemsLatestSourceUpdate;
  };
  readonly site: string;
  readonly projectKeys: readonly string[];
  /** Every imported item's labels; the step's grants cover exactly these. */
  readonly labels: readonly string[];
  readonly firstSyncHorizonDays: number;
  readonly now: () => Date;
};

export const jiraKeyPrefix = (projectKey: string): string => `${projectKey}-`;

function toItem(issue: JiraIssue, options: JiraImportOptions) {
  const mapped = mapJiraIssue(issue, { site: options.site });
  if (mapped.sourceUpdatedAt === null) {
    throw new StepError(
      "Scarn.StepFailed",
      `Jira issue ${issue.key} has no updated time, so it can't be imported.`,
    );
  }
  return {
    ...mapped,
    sourceUpdatedAt: mapped.sourceUpdatedAt,
    labels: [...options.labels],
    fields: { ...mapped.fields, jiraLabels: mapped.labels },
  };
}

async function sinceFor(
  options: JiraImportOptions,
  keyPrefix: string,
): Promise<string> {
  const latest = await options.workItems.latestSourceUpdate({
    platform: "jira",
    keyPrefix,
  });
  const now = options.now().getTime();
  const since =
    latest === null
      ? now - options.firstSyncHorizonDays * 24 * 60 * 60_000
      : Date.parse(latest) - JIRA_CURSOR_OVERLAP_MS;
  return new Date(since).toISOString();
}

async function importProject(
  options: JiraImportOptions,
  projectKey: string,
): Promise<JiraProjectImportResult> {
  const keyPrefix = jiraKeyPrefix(projectKey);
  const since = await sinceFor(options, keyPrefix);
  const result = { projectKey, seen: 0, upserted: 0 };
  let cursor: string | null = null;
  for (let pages = 0; ; pages += 1) {
    if (pages >= MAX_PAGES_PER_PROJECT) {
      throw new StepError(
        "Scarn.StepFailed",
        `Jira project ${projectKey}: gave up after ${String(pages)} pages.`,
      );
    }
    const page = await options.source.searchIssuesUpdatedSince({
      projectKey,
      since,
      cursor,
    });
    result.seen += page.issues.length;
    // A moved issue keeps matching its old project's history but not its
    // key; the step may only write keys under the project's prefix.
    const items = page.issues
      .filter((issue) => issue.key.startsWith(keyPrefix))
      .map((issue) => toItem(issue, options));
    for (let at = 0; at < items.length; at += MAX_WORK_ITEM_UPSERTS) {
      const saved = await options.workItems.upsert(
        items.slice(at, at + MAX_WORK_ITEM_UPSERTS),
      );
      result.upserted += saved.length;
    }
    if (page.next === null) return result;
    cursor = page.next;
  }
}

/** Imports each project key in turn, sequentially (Atlassian rate-limits bursts). */
export async function runJiraIssueImport(
  options: JiraImportOptions,
): Promise<JiraImportResult> {
  const projects: JiraProjectImportResult[] = [];
  for (const projectKey of options.projectKeys) {
    projects.push(await importProject(options, projectKey));
  }
  return {
    upserted: projects.reduce((sum, project) => sum + project.upserted, 0),
    projects,
  };
}
