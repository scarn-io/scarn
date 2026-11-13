/**
 * The CLI's command tree and top-level runner, kept apart from `index.ts` so
 * tests can drive `run()` without the entrypoint's `process.exit`.
 */
import yargs from "yargs/yargs";
import { hideBin } from "yargs/helpers";
import dotenv from "dotenv";
import { CoreError } from "@scarn/worker";

import { artifactsCommand } from "./commands/artifacts";
import { authCommand } from "./commands/auth";
import { automationsCommand } from "./commands/automations";
import { helloCommand } from "./commands/hello";
import { inboxCommand } from "./commands/inbox";
import { initCommand } from "./commands/init";
import { logsCommand } from "./commands/logs";
import { reportBugCommand } from "./commands/report-bug";
import { runsCommand } from "./commands/runs";
import { runtimeCommand } from "./commands/runtime";
import { pipelinesCommand } from "./commands/pipelines";
import { taskRunsCommand } from "./commands/task-runs";
import { tasksCommand } from "./commands/tasks";
import { telemetryCommand } from "./commands/telemetry";
import { workCommand } from "./commands/work";
import { workItemsCommand } from "./commands/work-items";
import { workerCommand } from "./commands/worker";
import { createCliLogger } from "./lib/logger";
import { AnalyticsEvents } from "@scarn/observability/analytics/events";
import { classifyCliError, CliError, CliUsageError } from "./lib/cli-error";
import { captureMilestone, shutdownTelemetry } from "./lib/telemetry";
import { version as CLI_VERSION } from "../package.json";
const logger = createCliLogger("cli");

interface YargsCommandContext {
  getInternalMethods(): { getContext(): { commands: string[] } };
}

/**
 * The declared command names yargs had matched when parsing failed (e.g.
 * `"pipelines push"`), read from its internal context because the public API
 * exposes nothing before middleware runs. Never includes positional values.
 */
function matchedCommandPath(cli: object): string {
  const commands = (cli as YargsCommandContext)
    .getInternalMethods()
    .getContext().commands;
  return commands.length > 0 ? commands.join(" ") : "unknown";
}

/**
 * The command tree. `onCommand` receives the resolved command path (e.g.
 * `"pipelines design"`) before its handler runs, so a failure can be
 * attributed to it.
 */
export function createCli(
  argv: readonly string[],
  onCommand: (command: string) => void = () => undefined,
) {
  const cli = yargs(argv);
  return cli
    .scriptName("scarn")
    .strict()
    .help()
    .version(CLI_VERSION)
    .fail((message, error) => {
      if (error instanceof Error) {
        throw error;
      }

      throw new CliUsageError(matchedCommandPath(cli), message);
    })
    .showHelpOnFail(false)
    .exitProcess(false)
    .option("envFile", {
      alias: "env-file",
      describe: "Path to an env file to load (defaults to .env)",
      type: "string",
      global: true,
    })
    .option("verbose", {
      alias: "v",
      describe: "Show full diagnostic logs alongside the UI",
      type: "boolean",
      default: false,
      global: true,
    })
    .middleware((arguments_) => {
      onCommand(arguments_._.map(String).join(" "));
      dotenv.config({ path: arguments_.envFile ?? ".env", override: false });
      dotenv.config({ path: ".scarn.env", override: false });
    })
    .command(artifactsCommand)
    .command(authCommand)
    .command(automationsCommand)
    .command(helloCommand)
    .command(inboxCommand)
    .command(initCommand)
    .command(logsCommand)
    .command(reportBugCommand)
    .command(runsCommand)
    .command(runtimeCommand)
    .command(pipelinesCommand)
    .command(taskRunsCommand)
    .command(tasksCommand)
    .command(telemetryCommand)
    .command(workCommand)
    .command(workItemsCommand)
    .command(workerCommand)
    .demandCommand(1, "A command is required.");
}

export async function run(
  argv: readonly string[] = hideBin(process.argv),
): Promise<number> {
  let command = "unknown";
  try {
    await createCli(argv, (resolved) => {
      command = resolved;
    }).parseAsync();
    return 0;
  } catch (error) {
    captureMilestone(AnalyticsEvents.CliCommandFailed, {
      command: error instanceof CliUsageError ? error.command : command,
      code: classifyCliError(error),
    });

    if (error instanceof CoreError) {
      logger.error(error.message);
    } else if (error instanceof Error) {
      logger.error({ err: error }, error.message);
    } else {
      logger.error({ error }, "Unknown CLI error.");
    }

    return error instanceof CliError ? error.exitCode : 1;
  } finally {
    // Bounded: never lets telemetry delay process exit by more than its own
    // timeout, whether the command above succeeded or threw.
    await shutdownTelemetry();
  }
}
