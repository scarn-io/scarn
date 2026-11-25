/**
 * `jiraIssueImport(...)`: a code step that imports a Jira site's issues for
 * some project keys as `jira` work items, and `jiraIssueImport.schedule(...)`,
 * the schedule rule that runs it.
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
import { parseJiraAuth, type JiraAuth } from "./auth";
import type { McpClient } from "../../definitions/steps/code-step-mcp-client";
import {
  DEFAULT_FIRST_SYNC_HORIZON_DAYS,
  jiraKeyPrefix,
  runJiraIssueImport,
  type JiraImportOptions,
} from "./import-loop";
import {
  ATLASSIAN_MCP_KEY,
  atlassianServerFor,
  createJiraMcpSourceClient,
  type AtlassianMcpHandle,
} from "./mcp-adapter";

export const DEFAULT_JIRA_IMPORT_LABELS = ["jira"] as const;
export const DEFAULT_JIRA_IMPORT_CRON = "*/5 * * * *";

const PROJECT_KEY = /^[A-Z][A-Z0-9_]*$/;

export type JiraIssueImportOptions = {
  /** The step's key. */
  readonly key: string;
  /** The step's name. Defaults to `Import Jira issues (<keys>)`. */
  readonly name?: string;
  /** The Jira Cloud site, e.g. `https://acme.atlassian.net`. */
  readonly site: string;
  /** Jira project keys, e.g. `["ABC"]`. Items are keyed `ABC-123`. */
  readonly projectKeys: readonly [string, ...string[]];
  /** Defaults to `{ type: "oauth", connection: "atlassian" }`. */
  readonly auth?: JiraAuth;
  /**
   * The Scarn labels every imported item carries; the step may set no
   * others. Defaults to `["jira"]`. Jira's own labels are kept in the item's
   * `fields.jiraLabels`.
   */
  readonly labels?: readonly [string, ...string[]];
  /** How far back the first run reaches. Defaults to 30 days. */
  readonly firstSyncHorizonDays?: number;
  readonly status?: "draft" | "active";
};

const resultSchema = z.object({
  upserted: z.number(),
  projects: z.array(
    z.object({
      projectKey: z.string(),
      seen: z.number(),
      upserted: z.number(),
    }),
  ),
});

function assertOptions(options: JiraIssueImportOptions): void {
  const fail = (message: string): never => {
    throw new Error(`jiraIssueImport "${options.key}": ${message}`);
  };
  if (options.projectKeys.length === 0) fail("projectKeys must not be empty.");
  for (const projectKey of options.projectKeys) {
    if (!PROJECT_KEY.test(projectKey)) {
      fail(
        `project key "${projectKey}" must be uppercase letters, digits and _, starting with a letter.`,
      );
    }
  }
  if (new Set(options.projectKeys).size !== options.projectKeys.length) {
    fail("projectKeys lists a key more than once.");
  }
  let site: URL | undefined;
  try {
    site = new URL(options.site);
  } catch {
    fail(`site "${options.site}" is not a URL.`);
  }
  if (site?.protocol !== "https:") fail("site must be an https:// URL.");
  const horizon = options.firstSyncHorizonDays;
  if (horizon !== undefined && !(Number.isInteger(horizon) && horizon > 0)) {
    fail("firstSyncHorizonDays must be a positive whole number.");
  }
}

type ImportContext = {
  readonly mcp: { readonly atlassian: McpClient<AtlassianMcpHandle> };
  readonly workItems: JiraImportOptions["workItems"];
};

/** The step's `fn`, before `codeStep` wraps it with the run's clients. */
export function jiraImportFn(
  options: Pick<
    JiraIssueImportOptions,
    "site" | "projectKeys" | "firstSyncHorizonDays"
  > & { readonly labels: readonly string[]; readonly now?: () => Date },
) {
  // eslint-disable-next-line local/no-unknown-parameter-type -- the step takes no input
  return (_input: unknown, context: ImportContext) =>
    runJiraIssueImport({
      source: createJiraMcpSourceClient({
        mcp: context.mcp.atlassian,
        site: options.site,
        ...(options.now ? { now: options.now } : {}),
      }),
      workItems: context.workItems,
      site: options.site,
      projectKeys: options.projectKeys,
      labels: options.labels,
      firstSyncHorizonDays:
        options.firstSyncHorizonDays ?? DEFAULT_FIRST_SYNC_HORIZON_DAYS,
      now: options.now ?? (() => new Date()),
    });
}

function buildStep(options: JiraIssueImportOptions) {
  assertOptions(options);
  const auth = parseJiraAuth(options.key, options.auth);
  const server = atlassianServerFor(auth);
  const labels = options.labels ?? DEFAULT_JIRA_IMPORT_LABELS;
  const features = [
    workItemFeatures.read({ scope: "project" }),
    ...options.projectKeys.flatMap((projectKey) => [
      workItemFeatures.create({
        scope: "project",
        labels,
        keyPrefix: jiraKeyPrefix(projectKey),
      }),
      workItemFeatures.update({
        scope: "project",
        keyPrefix: jiraKeyPrefix(projectKey),
        labels,
      }),
    ]),
  ];
  const run = jiraImportFn({ ...options, labels });
  return codeStep({
    key: options.key,
    name:
      options.name ?? `Import Jira issues (${options.projectKeys.join(", ")})`,
    status: options.status ?? "active",
    mcps: { [ATLASSIAN_MCP_KEY]: server.handle },
    features,
    resultSchema,
    fn: (input, context) =>
      run(input, {
        mcp: context.mcp,
        workItems: context.workItems,
      }),
  });
}

export type JiraIssueImportStep = ReturnType<typeof buildStep>;

export type JiraIssueImportScheduleOptions = {
  /** Defaults to every 5 minutes. */
  readonly cron?: string;
  /** IANA timezone the cron is read in. Defaults to UTC. */
  readonly timezone?: string;
  /** The rule's key. Defaults to `import`. */
  readonly key?: string;
};

/** A schedule rule, for a `defineAutomation`'s `rules`, that runs `step`. */
function schedule(
  step: JiraIssueImportStep,
  options: JiraIssueImportScheduleOptions = {},
): Rule<"schedule"> {
  return onEvent({
    key: options.key ?? "import",
    event: "schedule",
    cron: options.cron ?? DEFAULT_JIRA_IMPORT_CRON,
    ...(options.timezone !== undefined ? { timezone: options.timezone } : {}),
    to: () => step({}),
  });
}

/**
 * A code step that imports Jira issues as `jira` work items, keyed by issue
 * key, for the given project keys. Export it from a `.scarn` file and start it
 * with `jiraIssueImport.schedule(step)` in an automation.
 */
export const jiraIssueImport = Object.assign(buildStep, { schedule });
