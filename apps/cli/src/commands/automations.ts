import type { ArgumentsCamelCase, Argv, CommandModule } from "yargs";
import {
  AutomationsApiError,
  createAutomationsClient,
  type AutomationListItem,
  type AutomationScheduleSummary,
} from "@scarn/sdk/definitions/automations";
import type { FetchLike } from "@scarn/sdk/auth";
import { resolveScarnBaseUrl } from "@scarn/worker";
import { connectApi } from "../lib/cli-api-client";
import { CliError } from "../lib/cli-error";
import { withReporter } from "../lib/command-output";
import {
  withOutputOptions,
  writeJson,
  writeText,
  type OutputArguments,
} from "../lib/output";
import { parseWorkItemReference } from "../lib/design-work-item";
import { findWorkItemByUrl } from "../lib/design-work-item-adapters";
import { PROJECT_ACTIONS } from "../lib/resolve-project-ref";
import { syncIdentityFromDisk } from "../lib/telemetry";
import {
  connectProject,
  withProjectOptions,
  type ProjectArguments,
} from "../lib/connect-project";

/**
 * `scarn automations`: list the project's automations and their schedules,
 * turn project automations on and off, run a schedule now, and attach or detach work-item automations. Publishing happens in `scarn pipelines push`.
 */

async function requestAutomation<T>(
  action: string,
  request: () => Promise<T>,
): Promise<T> {
  try {
    return await request();
  } catch (error) {
    if (error instanceof AutomationsApiError) {
      throw new CliError(
        "automation_request_failed",
        `Could not ${action}: ${error.message}`,
        { cause: error },
      );
    }
    throw error;
  }
}

// list

const ERROR_PREVIEW_LENGTH = 120;

const truncate = (text: string, length: number): string => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > length ? `${line.slice(0, length - 1)}…` : line;
};

/** One schedule rule's summary, as indented lines under its automation. */
export function formatScheduleSummary(
  schedule: AutomationScheduleSummary,
): string[] {
  const next =
    schedule.nextRunAt === null ? "disabled" : `next ${schedule.nextRunAt}`;
  const lines = [
    `    schedule ${schedule.key}  ${schedule.cron} (${schedule.timezone})  ${next}`,
  ];
  const facts = [
    `last fired ${schedule.lastFiredAt ?? "never"}`,
    schedule.lastTask === null
      ? "no Tasks yet"
      : `last Task ${schedule.lastTask.status} (${schedule.lastTask.id})`,
    ...(schedule.failureStreak > 0
      ? [`${String(schedule.failureStreak)} failed in a row`]
      : []),
  ];
  lines.push(`      ${facts.join("  ")}`);
  if (schedule.lastSkippedAt !== null) {
    lines.push(
      `      last skipped ${schedule.lastSkippedAt} (${String(schedule.skippedCountSinceFire)} since the last fire)`,
    );
  }
  if (schedule.lastError !== null) {
    lines.push(
      `      last error ${schedule.lastError.at}: ${truncate(schedule.lastError.message, ERROR_PREVIEW_LENGTH)}`,
    );
  }
  return lines;
}

/** The project's automations, with each project automation's schedule rules. */
export function formatAutomationList(
  automations: readonly AutomationListItem[],
): string {
  if (automations.length === 0) return "No automations in this project.";
  const lines = [`Automations (${String(automations.length)})`];
  for (const automation of automations) {
    const state =
      automation.scope === "project"
        ? automation.enabled
          ? "enabled"
          : "disabled"
        : "work-item";
    const version =
      automation.latestVersion === null
        ? "unpublished"
        : `v${String(automation.latestVersion.version)}`;
    lines.push(
      `  ${automation.key}  ${state}  ${version}${automation.title === null || automation.title === automation.key ? "" : `  ${automation.title}`}`,
    );
    for (const schedule of automation.schedules) {
      lines.push(...formatScheduleSummary(schedule));
    }
  }
  return lines.join("\n");
}

type ListArguments = ProjectArguments & OutputArguments;

const listCommand: CommandModule<object, ListArguments> = {
  command: "list",
  describe:
    "List the project's automations with each schedule's next run, last Task and errors",
  builder: (argv: Argv<object>) => withOutputOptions(withProjectOptions(argv)),
  handler: (args: ArgumentsCamelCase<ListArguments>) =>
    withReporter("automations-list", async () => {
      const { baseUrl, fetch, projectId } = await connectProject(
        args,
        PROJECT_ACTIONS.automations,
      );
      const automations = await requestAutomation("list automations", () =>
        createAutomationsClient(baseUrl, { fetch }).listByProjectId(projectId),
      );
      const shown =
        args.limit === undefined
          ? automations
          : automations.slice(0, args.limit);
      if (args.json) writeJson(shown);
      else writeText(formatAutomationList(shown));
    }),
};

// enable / disable

interface ToggleArguments extends ProjectArguments {
  key: string;
}

const runToggle =
  (enabled: boolean) => (args: ArgumentsCamelCase<ToggleArguments>) =>
    withReporter(
      enabled ? "automations-enable" : "automations-disable",
      async ({ reporter }) => {
        const { baseUrl, fetch, projectId } = await connectProject(
          args,
          PROJECT_ACTIONS.automations,
        );
        const automations = createAutomationsClient(baseUrl, { fetch });
        await requestAutomation(
          `${enabled ? "enable" : "disable"} "${args.key}"`,
          () =>
            enabled
              ? automations.enable(projectId, args.key)
              : automations.disable(projectId, args.key),
        );
        reporter.success(
          enabled
            ? `"${args.key}" is enabled; it reacts to new project events.`
            : `"${args.key}" is disabled.`,
        );
      },
    );

const toggleCommand = (
  enabled: boolean,
): CommandModule<object, ToggleArguments> => ({
  command: `${enabled ? "enable" : "disable"} <key>`,
  describe: enabled
    ? "Turn on a project automation"
    : "Turn off a project automation",
  builder: (argv: Argv<object>) =>
    withProjectOptions(
      argv.positional("key", {
        describe: "The automation key",
        type: "string",
        demandOption: true,
      }),
    ),
  handler: runToggle(enabled),
});

// run

interface RunArguments extends ProjectArguments {
  key: string;
  ruleKey: string;
}

const CONCURRENCY_GROUP_FULL = "Scarn.ConcurrencyGroupFull";

const runSchedule = (args: ArgumentsCamelCase<RunArguments>) =>
  withReporter("automations-run", async ({ reporter }) => {
    const { baseUrl, fetch, projectId } = await connectProject(
      args,
      PROJECT_ACTIONS.automations,
    );
    const label = `"${args.key}" schedule "${args.ruleKey}"`;
    const started = await requestAutomation(`run ${label}`, async () => {
      try {
        return await createAutomationsClient(baseUrl, { fetch }).runSchedule(
          projectId,
          args.key,
          args.ruleKey,
        );
      } catch (error) {
        if (
          error instanceof AutomationsApiError &&
          error.code === CONCURRENCY_GROUP_FULL
        ) {
          const held =
            error.heldBy.length === 0
              ? ""
              : ` (held by Task${error.heldBy.length === 1 ? "" : "s"} ${error.heldBy.join(", ")})`;
          throw new CliError(
            "automation_schedule_busy",
            `Could not run ${label}: a run is already open${held}. Wait for it to finish or cancel it with \`scarn tasks cancel <taskId>\`.`,
            { cause: error },
          );
        }
        throw error;
      }
    });
    if (started.taskId === null) {
      reporter.success(
        `Ran ${label} for ${started.scheduledFor}; the rule routed to skip, so no Task started.`,
      );
      return;
    }
    reporter.success(
      `Ran ${label} for ${started.scheduledFor}: started Task ${started.taskId}.`,
    );
    reporter.info(`Next: scarn tasks view ${started.taskId}`);
  });

const runCommand: CommandModule<object, RunArguments> = {
  command: "run <key> <ruleKey>",
  describe:
    "Run a project automation's schedule now, even while the automation is disabled; its next run doesn't move",
  builder: (argv: Argv<object>) =>
    withProjectOptions(
      argv
        .positional("key", {
          describe: "The automation key",
          type: "string",
          demandOption: true,
        })
        .positional("ruleKey", {
          describe: "The key of the automation's schedule rule",
          type: "string",
          demandOption: true,
        }),
    ),
  handler: runSchedule,
};

// attach / detach

interface WorkItemArguments extends ProjectArguments {
  workItem: string;
  key: string;
}

/**
 * A work item id as-is; a ticket URL looked up in the project. Only the URL
 * form needs the project.
 */
async function resolveWorkItemId(
  args: ArgumentsCamelCase<WorkItemArguments>,
): Promise<{
  baseUrl: string;
  fetch: FetchLike;
  workItemId: string;
}> {
  const reference = parseWorkItemReference(args.workItem);
  if (reference === undefined) {
    throw new CliError(
      "invalid_usage",
      `"${args.workItem}" is not a work item. Pass its id or its ticket URL.`,
    );
  }
  if (reference.kind === "id") {
    const baseUrl = resolveScarnBaseUrl(args.baseUrl);
    const { fetch } = await connectApi(baseUrl);
    syncIdentityFromDisk(baseUrl);
    return { baseUrl, fetch, workItemId: reference.value };
  }
  const { baseUrl, fetch, projectId } = await connectProject(
    args,
    PROJECT_ACTIONS.automations,
  );
  const workItem = await findWorkItemByUrl({
    baseUrl,
    projectId,
    url: reference.value,
  });
  if (workItem === undefined) {
    throw new CliError(
      "no_work_item",
      `No work item with URL ${reference.value} in this project.`,
    );
  }
  return { baseUrl, fetch, workItemId: workItem.id };
}

const runAttach = (args: ArgumentsCamelCase<WorkItemArguments>) =>
  withReporter("automations-attach", async ({ reporter }) => {
    const { baseUrl, fetch, workItemId } = await resolveWorkItemId(args);
    await requestAutomation(`attach "${args.key}"`, () =>
      createAutomationsClient(baseUrl, { fetch }).attach(workItemId, args.key),
    );
    reporter.success(`Attached "${args.key}" to work item ${workItemId}.`);
  });

const runDetach = (args: ArgumentsCamelCase<WorkItemArguments>) =>
  withReporter("automations-detach", async ({ reporter }) => {
    const { baseUrl, fetch, workItemId } = await resolveWorkItemId(args);
    await requestAutomation(`detach "${args.key}"`, () =>
      createAutomationsClient(baseUrl, { fetch }).detach(workItemId, args.key),
    );
    reporter.success(`Detached "${args.key}" from work item ${workItemId}.`);
  });

const workItemBuilder = (argv: Argv<object>) =>
  withProjectOptions(
    argv
      .positional("workItem", {
        describe: "The work item, as its id or its ticket URL",
        type: "string",
        demandOption: true,
      })
      .positional("key", {
        describe: "The work-item automation key",
        type: "string",
        demandOption: true,
      }),
  );

const attachCommand: CommandModule<object, WorkItemArguments> = {
  command: "attach <workItem> <key>",
  describe: "Attach a work-item automation to a work item",
  builder: workItemBuilder,
  handler: runAttach,
};

const detachCommand: CommandModule<object, WorkItemArguments> = {
  command: "detach <workItem> <key>",
  describe: "Detach a work-item automation from a work item",
  builder: workItemBuilder,
  handler: runDetach,
};

// parent

export const automationsCommand: CommandModule<object, object> = {
  command: "automations <command>",
  describe: "List, enable, disable, run, attach and detach automations",
  builder: (argv) =>
    argv
      .command(listCommand)
      .command(attachCommand)
      .command(detachCommand)
      .command(toggleCommand(true))
      .command(toggleCommand(false))
      .command(runCommand)
      .demandCommand(1, "An automations command is required."),
  handler: () => undefined,
};
