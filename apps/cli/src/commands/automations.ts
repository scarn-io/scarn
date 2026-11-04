import type { ArgumentsCamelCase, Argv, CommandModule } from "yargs";
import {
  AutomationsApiError,
  createAutomationsClient,
} from "@scarn/sdk/definitions/automations";
import { resolveScarnBaseUrl } from "@scarn/worker";
import { connectApi } from "../lib/cli-api-client";
import { CliError } from "../lib/cli-error";
import { withReporter } from "../lib/command-output";
import { parseWorkItemReference } from "../lib/design-work-item";
import { findWorkItemByUrl } from "../lib/design-work-item-adapters";
import { PROJECT_ACTIONS } from "../lib/resolve-project-ref";
import { syncIdentityFromDisk } from "../lib/telemetry";
import {
  connectProject,
  withProjectOptions,
  type ProjectArguments,
} from "./pipelines-documents";

/**
 * `scarn automations`: turn project automations on and off, and attach or
 * detach work-item automations. Publishing happens in `scarn pipelines push`.
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

// enable / disable

interface ToggleArguments extends ProjectArguments {
  key: string;
}

const runToggle =
  (enabled: boolean) => (args: ArgumentsCamelCase<ToggleArguments>) =>
    withReporter(
      enabled ? "automations-enable" : "automations-disable",
      async ({ reporter }) => {
        const { baseUrl, headers, projectId } = await connectProject(
          args,
          PROJECT_ACTIONS.automations,
        );
        const automations = createAutomationsClient(baseUrl);
        await requestAutomation(
          `${enabled ? "enable" : "disable"} "${args.key}"`,
          () =>
            enabled
              ? automations.enable(projectId, args.key, { headers })
              : automations.disable(projectId, args.key, { headers }),
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
  headers: { Authorization: string };
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
    const { headers } = await connectApi(baseUrl);
    syncIdentityFromDisk(baseUrl);
    return { baseUrl, headers, workItemId: reference.value };
  }
  const { baseUrl, headers, projectId } = await connectProject(
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
  return { baseUrl, headers, workItemId: workItem.id };
}

const runAttach = (args: ArgumentsCamelCase<WorkItemArguments>) =>
  withReporter("automations-attach", async ({ reporter }) => {
    const { baseUrl, headers, workItemId } = await resolveWorkItemId(args);
    await requestAutomation(`attach "${args.key}"`, () =>
      createAutomationsClient(baseUrl).attach(workItemId, args.key, {
        headers,
      }),
    );
    reporter.success(`Attached "${args.key}" to work item ${workItemId}.`);
  });

const runDetach = (args: ArgumentsCamelCase<WorkItemArguments>) =>
  withReporter("automations-detach", async ({ reporter }) => {
    const { baseUrl, headers, workItemId } = await resolveWorkItemId(args);
    await requestAutomation(`detach "${args.key}"`, () =>
      createAutomationsClient(baseUrl).detach(workItemId, args.key, {
        headers,
      }),
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
  describe: "Enable, disable, attach and detach automations",
  builder: (argv) =>
    argv
      .command(attachCommand)
      .command(detachCommand)
      .command(toggleCommand(true))
      .command(toggleCommand(false))
      .demandCommand(1, "An automations command is required."),
  handler: () => undefined,
};
