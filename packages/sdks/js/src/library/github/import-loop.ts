/**
 * `githubIssueImport`'s loop: per repo, resume from the newest stored
 * `sourceUpdatedAt` under `owner/repo#` (minus an overlap), page through the
 * source oldest first, and upsert page by page. Every saved page is older
 * than every unsaved one, so a crash or failure never moves the cursor past
 * an issue that wasn't saved. It only sees the `GitHubSourceClient`.
 */
import { MAX_WORK_ITEM_UPSERTS } from "../../contracts/step-bridge";
import type {
  WorkItemsLatestSourceUpdate,
  WorkItemsUpsert,
} from "../../definitions/steps/code-step-work-items-client";
import { StepError } from "../../definitions/steps/step-error";
import { mapGitHubIssue, type GitHubIssue } from "./map-github-issue";
import type { GitHubSourceClient } from "./source-client";

/** Re-read this much before the cursor, to cover equal timestamps. */
export const GITHUB_CURSOR_OVERLAP_MS = 5 * 60_000;
export const DEFAULT_FIRST_SYNC_HORIZON_DAYS = 30;
/** A run that pages more than this is stuck, not busy. */
const MAX_PAGES_PER_REPO = 10_000;

export type GitHubRepoImportResult = {
  repo: string;
  /** Issues the source returned, counting any it returned twice. */
  seen: number;
  /** Items created or updated; unchanged ones aren't counted. */
  upserted: number;
};

export type GitHubImportResult = {
  upserted: number;
  repos: GitHubRepoImportResult[];
};

export type GitHubImportOptions = {
  readonly source: GitHubSourceClient;
  readonly workItems: {
    readonly upsert: WorkItemsUpsert;
    readonly latestSourceUpdate: WorkItemsLatestSourceUpdate;
  };
  /** `owner/repo` names. */
  readonly repos: readonly string[];
  /** Every imported item's labels; the step's grants cover exactly these. */
  readonly labels: readonly string[];
  readonly firstSyncHorizonDays: number;
  readonly now: () => Date;
};

export const githubKeyPrefix = (repo: string): string => `${repo}#`;

function toItem(issue: GitHubIssue, repo: string, labels: readonly string[]) {
  const mapped = mapGitHubIssue(issue, { repo });
  if (Number.isNaN(Date.parse(mapped.sourceUpdatedAt))) {
    throw new StepError(
      "Scarn.StepFailed",
      `GitHub issue ${mapped.platformKey} has no valid updated time, so it can't be imported.`,
    );
  }
  return {
    ...mapped,
    labels: [...labels],
    fields: { ...mapped.fields, githubLabels: mapped.labels },
  };
}

async function sinceFor(
  options: GitHubImportOptions,
  keyPrefix: string,
): Promise<string> {
  const latest = await options.workItems.latestSourceUpdate({
    platform: "github",
    keyPrefix,
  });
  const now = options.now().getTime();
  const since =
    latest === null
      ? now - options.firstSyncHorizonDays * 24 * 60 * 60_000
      : Date.parse(latest) - GITHUB_CURSOR_OVERLAP_MS;
  return new Date(since).toISOString();
}

async function importRepo(
  options: GitHubImportOptions,
  repo: string,
): Promise<GitHubRepoImportResult> {
  const since = await sinceFor(options, githubKeyPrefix(repo));
  const result = { repo, seen: 0, upserted: 0 };
  let cursor: string | null = null;
  for (let pages = 0; ; pages += 1) {
    if (pages >= MAX_PAGES_PER_REPO) {
      throw new StepError(
        "Scarn.StepFailed",
        `GitHub repo ${repo}: gave up after ${String(pages)} pages.`,
      );
    }
    const page = await options.source.listIssuesUpdatedSince({
      repo,
      since,
      cursor,
    });
    result.seen += page.issues.length;
    const items = page.issues
      .filter((issue) => issue.pull_request === undefined)
      .map((issue) => toItem(issue, repo, options.labels));
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

/** Imports each repo in turn, sequentially, to spend the token's quota gently. */
export async function runGitHubIssueImport(
  options: GitHubImportOptions,
): Promise<GitHubImportResult> {
  const repos: GitHubRepoImportResult[] = [];
  for (const repo of options.repos) {
    repos.push(await importRepo(options, repo));
  }
  return {
    upserted: repos.reduce((sum, repo) => sum + repo.upserted, 0),
    repos,
  };
}
