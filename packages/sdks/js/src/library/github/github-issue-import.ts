/**
 * `githubIssueImport(...)`: a code step that imports GitHub repos' issues as
 * `github` work items, and `githubIssueImport.schedule(...)`, the schedule
 * rule that runs it.
 *
 * The user exports the returned step from their own `.scarn` file. That file
 * is the step's `sourceFile`: the worker re-imports it and finds the step by
 * `key`, so the `fn` (which lives here, in `node_modules`) runs as any other
 * code step's would.
 */
import { onEvent } from "../../automations/define-automation";
import type { Rule } from "../../automations/types";
import { codeStep } from "../../definitions/steps/define-code-step";
import { workItems as workItemFeatures } from "../../definitions/steps/work-item-features";
import { z } from "zod";
import { parseGitHubAuth, type GitHubAuth } from "./auth";
import type { McpClient } from "../../definitions/steps/code-step-mcp-client";
import {
  DEFAULT_FIRST_SYNC_HORIZON_DAYS,
  githubKeyPrefix,
  runGitHubIssueImport,
  type GitHubImportOptions,
} from "./import-loop";
import {
  createGitHubMcpSourceClient,
  GITHUB_MCP_KEY,
  githubServerFor,
  type GitHubMcpHandle,
} from "./mcp-adapter";

export const DEFAULT_GITHUB_IMPORT_LABELS = ["github"] as const;
export const DEFAULT_GITHUB_IMPORT_CRON = "*/5 * * * *";

const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/;

export type GitHubIssueImportOptions = {
  /** The step's key. */
  readonly key: string;
  /** The step's name. Defaults to `Import GitHub issues (<repos>)`. */
  readonly name?: string;
  /** Repos as `owner/repo`. Items are keyed `owner/repo#123`. */
  readonly repos: readonly [string, ...string[]];
  /** A token with read access to the repos' issues. Required. */
  readonly auth: GitHubAuth;
  /**
   * The Scarn labels every imported item carries; the step may set no
   * others. Defaults to `["github"]`. GitHub's own labels are kept in the
   * item's `fields.githubLabels`.
   */
  readonly labels?: readonly [string, ...string[]];
  /** How far back the first run reaches. Defaults to 30 days. */
  readonly firstSyncHorizonDays?: number;
  readonly status?: "draft" | "active";
};

const resultSchema = z.object({
  upserted: z.number(),
  repos: z.array(
    z.object({
      repo: z.string(),
      seen: z.number(),
      upserted: z.number(),
    }),
  ),
});

function assertOptions(options: GitHubIssueImportOptions): void {
  const fail = (message: string): never => {
    throw new Error(`githubIssueImport "${options.key}": ${message}`);
  };
  if (options.repos.length === 0) fail("repos must not be empty.");
  for (const repo of options.repos) {
    if (!REPO.test(repo)) fail(`repo "${repo}" must be "owner/repo".`);
  }
  const lowered = options.repos.map((repo) => repo.toLowerCase());
  if (new Set(lowered).size !== lowered.length) {
    fail("repos lists a repo more than once.");
  }
  const horizon = options.firstSyncHorizonDays;
  if (horizon !== undefined && !(Number.isInteger(horizon) && horizon > 0)) {
    fail("firstSyncHorizonDays must be a positive whole number.");
  }
}

type ImportContext = {
  readonly mcp: { readonly github: McpClient<GitHubMcpHandle> };
  readonly workItems: GitHubImportOptions["workItems"];
};

/** The step's `fn`, before `codeStep` wraps it with the run's clients. */
export function githubImportFn(
  options: Pick<GitHubIssueImportOptions, "repos" | "firstSyncHorizonDays"> & {
    readonly labels: readonly string[];
    readonly now?: () => Date;
  },
) {
  // eslint-disable-next-line local/no-unknown-parameter-type -- the step takes no input
  return (_input: unknown, context: ImportContext) =>
    runGitHubIssueImport({
      source: createGitHubMcpSourceClient({ mcp: context.mcp.github }),
      workItems: context.workItems,
      repos: options.repos,
      labels: options.labels,
      firstSyncHorizonDays:
        options.firstSyncHorizonDays ?? DEFAULT_FIRST_SYNC_HORIZON_DAYS,
      now: options.now ?? (() => new Date()),
    });
}

function buildStep(options: GitHubIssueImportOptions) {
  assertOptions(options);
  const auth = parseGitHubAuth(options.key, options.auth);
  const server = githubServerFor(auth);
  const labels = options.labels ?? DEFAULT_GITHUB_IMPORT_LABELS;
  const features = [
    workItemFeatures.read({ scope: "project" }),
    ...options.repos.flatMap((repo) => [
      workItemFeatures.create({
        scope: "project",
        labels,
        keyPrefix: githubKeyPrefix(repo),
      }),
      workItemFeatures.update({
        scope: "project",
        keyPrefix: githubKeyPrefix(repo),
        labels,
      }),
    ]),
  ];
  const run = githubImportFn({ ...options, labels });
  return codeStep({
    key: options.key,
    name: options.name ?? `Import GitHub issues (${options.repos.join(", ")})`,
    status: options.status ?? "active",
    mcps: { [GITHUB_MCP_KEY]: server.handle },
    features,
    resultSchema,
    fn: (input, context) =>
      run(input, {
        mcp: context.mcp,
        workItems: context.workItems,
      }),
  });
}

export type GitHubIssueImportStep = ReturnType<typeof buildStep>;

export type GitHubIssueImportScheduleOptions = {
  /** Defaults to every 5 minutes. */
  readonly cron?: string;
  /** IANA timezone the cron is read in. Defaults to UTC. */
  readonly timezone?: string;
  /** The rule's key. Defaults to `import`. */
  readonly key?: string;
};

/** A schedule rule, for a `defineAutomation`'s `rules`, that runs `step`. */
function schedule(
  step: GitHubIssueImportStep,
  options: GitHubIssueImportScheduleOptions = {},
): Rule<"schedule"> {
  return onEvent({
    key: options.key ?? "import",
    event: "schedule",
    cron: options.cron ?? DEFAULT_GITHUB_IMPORT_CRON,
    ...(options.timezone !== undefined ? { timezone: options.timezone } : {}),
    to: () => step({}),
  });
}

/**
 * A code step that imports GitHub issues as `github` work items, keyed
 * `owner/repo#number`, for the given repos, through GitHub's remote MCP
 * server with a personal access token. Export it from a `.scarn` file and
 * start it with `githubIssueImport.schedule(step)` in an automation.
 *
 * If you can install Scarn's GitHub App on the repos, use the App instead:
 * it syncs through webhooks and also imports parent links and blocks. This
 * library is for repos where you can't install it.
 *
 * Limits: parent links and blocks are not imported; pull requests are
 * skipped. GitHub's `list_issues` doesn't return an issue's node id, close
 * reason or close time, so `platformId` is left as stored and
 * `fields.stateReason` and `fields.closedAt` are `null`.
 */
export const githubIssueImport = Object.assign(buildStep, { schedule });
