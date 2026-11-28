/**
 * `jiraIssueImport`'s loop. Each project key resumes from the newest stored
 * `sourceUpdatedAt` under `<KEY>-` (minus an overlap); one search covers
 * every key from the earliest of those, paged oldest first, and each page is
 * routed to its keys and upserted before the next is read. Results are in
 * ascending `updated` order across all keys, so for every key each saved
 * issue is older than each unsaved one: a crash or failure never moves a
 * key's cursor past an issue that wasn't saved. It only sees the
 * `JiraSourceClient`.
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
const MAX_PAGES_PER_RUN = 10_000;

export type JiraProjectImportResult = {
  projectKey: string;
  /**
   * Issues under this key the source returned inside the key's own window,
   * counting any it returned twice.
   */
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

type KeyState = { result: JiraProjectImportResult; since: number };

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
): Promise<number> {
  const latest = await options.workItems.latestSourceUpdate({
    platform: "jira",
    keyPrefix,
  });
  const now = options.now().getTime();
  return latest === null
    ? now - options.firstSyncHorizonDays * 24 * 60 * 60_000
    : Date.parse(latest) - JIRA_CURSOR_OVERLAP_MS;
}

/** The project key an issue key such as `ABC-12` belongs to. */
function projectKeyOf(issueKey: string): string | null {
  const dash = issueKey.lastIndexOf("-");
  return dash > 0 ? issueKey.slice(0, dash) : null;
}

function stateOf(
  keys: ReadonlyMap<string, KeyState>,
  issueKey: string,
): KeyState | undefined {
  const projectKey = projectKeyOf(issueKey);
  return projectKey === null ? undefined : keys.get(projectKey);
}

/**
 * Routes one page to its keys and upserts it. A moved issue keeps matching
 * its old project's history but not its key, so an issue under no requested
 * key is dropped: the step may only write keys under its projects' prefixes.
 * An issue older than its own key's `since` was saved by an earlier run (the
 * search reaches back to the laggiest key), and is skipped.
 */
async function importPage(
  options: JiraImportOptions,
  keys: ReadonlyMap<string, KeyState>,
  issues: readonly JiraIssue[],
): Promise<void> {
  const items = [];
  for (const issue of issues) {
    const state = stateOf(keys, issue.key);
    if (!state) continue;
    const item = toItem(issue, options);
    if (Date.parse(item.sourceUpdatedAt) < state.since) continue;
    state.result.seen += 1;
    items.push(item);
  }
  for (let at = 0; at < items.length; at += MAX_WORK_ITEM_UPSERTS) {
    const saved = await options.workItems.upsert(
      items.slice(at, at + MAX_WORK_ITEM_UPSERTS),
    );
    for (const item of saved) {
      const state = stateOf(keys, item.platformKey);
      if (state) state.result.upserted += 1;
    }
  }
}

/**
 * Imports every project key with one search, page by page (Atlassian
 * rate-limits bursts).
 */
export async function runJiraIssueImport(
  options: JiraImportOptions,
): Promise<JiraImportResult> {
  const keys = new Map<string, KeyState>();
  for (const projectKey of options.projectKeys) {
    keys.set(projectKey, {
      result: { projectKey, seen: 0, upserted: 0 },
      since: await sinceFor(options, jiraKeyPrefix(projectKey)),
    });
  }
  const states = [...keys.values()];
  if (states.length > 0) {
    const since = new Date(
      Math.min(...states.map((state) => state.since)),
    ).toISOString();
    let cursor: string | null = null;
    for (let pages = 0; ; pages += 1) {
      if (pages >= MAX_PAGES_PER_RUN) {
        throw new StepError(
          "Scarn.StepFailed",
          `Jira import: gave up after ${String(pages)} pages.`,
        );
      }
      const page = await options.source.searchIssuesUpdatedSince({
        projectKeys: [...keys.keys()],
        since,
        cursor,
      });
      await importPage(options, keys, page.issues);
      if (page.next === null) break;
      cursor = page.next;
    }
  }
  const projects = states.map((state) => state.result);
  return {
    upserted: projects.reduce((sum, project) => sum + project.upserted, 0),
    projects,
  };
}
