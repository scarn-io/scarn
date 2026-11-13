import type { ArgumentsCamelCase, Argv, CommandModule } from "yargs";
import {
  followTaskRunLogs,
  formatTaskRunLogs,
  gatherTaskRunLogs,
  renderFollowedLines,
  renderTaskRunLogText,
  resolveTaskRun,
  taskRunLogHints,
  taskRunLogsJson,
  type LogLineSelection,
  type SavedLog,
  type TaskLogStream,
} from "@scarn/shared-core";
import { CliError } from "../lib/cli-error";
import { withReporter } from "../lib/command-output";
import { withBaseUrlOption } from "../lib/connect-project";
import { writeJson, writeText } from "../lib/output";
import {
  realTaskRunDebugDependencies,
  type TaskRunDebugDependencies,
} from "../lib/task-run-debug-dependencies";

/**
 * `scarn logs`: a Task run's worker, AI server and conversation log. The
 * full log is always saved under `~/.scarn/task-logs/`; stdout gets the
 * capped tail, or the lines `--grep` / `--tail` / `--since-line` select.
 */

const STREAMS = ["worker", "ai-server", "conversation"] as const;

interface LogsArguments {
  id: string;
  run: number | undefined;
  stream: TaskLogStream | undefined;
  tail: number | undefined;
  grep: string | undefined;
  sinceLine: number | undefined;
  follow: boolean;
  json: boolean;
  baseUrl: string | undefined;
}

function parseGrep(pattern: string | undefined): RegExp | undefined {
  if (pattern === undefined) return undefined;
  try {
    return new RegExp(pattern);
  } catch (error) {
    throw new CliError(
      "invalid_usage",
      `--grep is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function checkUsage(args: LogsArguments): void {
  if (args.follow && args.json) {
    throw new CliError(
      "invalid_usage",
      "--follow cannot be combined with --json; run `scarn logs --json` once the run has finished.",
    );
  }
  if (args.follow && (args.grep !== undefined || args.tail !== undefined)) {
    throw new CliError(
      "invalid_usage",
      "--follow cannot be combined with --grep or --tail; follow first, then search the saved log.",
    );
  }
  for (const [flag, value] of [
    ["--tail", args.tail],
    ["--since-line", args.sinceLine],
    ["--run", args.run],
  ] as const) {
    if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
      throw new CliError(
        "invalid_usage",
        `${flag} must be a non-negative whole number.`,
      );
    }
  }
}

async function save(
  deps: TaskRunDebugDependencies,
  taskRunId: string,
  stream: TaskLogStream | "all",
  fullText: string,
): Promise<SavedLog> {
  try {
    return {
      path: await deps.saveFullLog({
        taskRunId,
        requestedStream: stream,
        fullText,
      }),
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

const buildLogsCommand = (
  deps: TaskRunDebugDependencies,
): CommandModule<object, LogsArguments> => ({
  command: "logs <id>",
  describe:
    "Show a Task run's logs (pass a Task id for its latest run); saves the full log to ~/.scarn/task-logs/",
  builder: (argv: Argv<object>) =>
    withBaseUrlOption(argv)
      .positional("id", {
        describe: "A Task run ID, or a Task ID for its latest run",
        type: "string",
        demandOption: true,
      })
      .option("run", {
        describe: "With a Task ID: show run number N instead of the latest",
        type: "number",
      })
      .option("stream", {
        describe: "Only this stream (default: all three)",
        choices: STREAMS,
      })
      .option("tail", {
        describe: "Only the last N lines",
        type: "number",
      })
      .option("grep", {
        describe:
          "Only lines matching this regular expression, with their line numbers",
        type: "string",
      })
      .option("since-line", {
        describe: "Only lines after line N of the saved log",
        type: "number",
      })
      .option("follow", {
        describe:
          "Keep printing new lines every 2s until the run finishes and its log is archived",
        type: "boolean",
        default: false,
      })
      .option("json", {
        describe: "Print the selected lines as a single JSON document",
        type: "boolean",
        default: false,
      }) as unknown as Argv<LogsArguments>,
  handler: (args: ArgumentsCamelCase<LogsArguments>) =>
    withReporter("logs", async ({ reporter }) => {
      checkUsage(args);
      const selection: LogLineSelection = {
        grep: parseGrep(args.grep),
        tail: args.tail,
        sinceLine: args.sinceLine,
      };
      const stream = args.stream ?? "all";
      const { client, headers } = await deps.connect(args);
      const run = await resolveTaskRun({
        client,
        headers,
        id: args.id,
        runNumber: args.run,
      });
      const gathered = await gatherTaskRunLogs({
        client,
        headers,
        run,
        stream,
      });
      const fullText = renderTaskRunLogText(gathered);
      const saved = await save(deps, run.id, stream, fullText);
      const input = { gathered, fullText, saved, selection };

      if (args.json) {
        writeJson(taskRunLogsJson(input));
        return;
      }
      writeText(formatTaskRunLogs({ ...input, withHints: !args.follow }));
      if (!args.follow) return;

      if (gathered.source === "archive") {
        reporter.info("The run has finished; there is nothing to follow.");
      } else {
        reporter.info("Following new lines until the run is archived…");
        const followed = await followTaskRunLogs({
          client,
          headers,
          taskRunId: run.id,
          stream,
          from: gathered.nextOffset,
          sleep: (ms) => deps.sleep(ms),
          onLines: (lines) => {
            writeText(renderFollowedLines(lines));
          },
        });
        const refreshed = renderTaskRunLogText({
          ...gathered,
          lines: [...gathered.lines, ...followed],
        });
        const final = await save(deps, run.id, stream, refreshed);
        writeText([
          "",
          `Run finished. Full log: ${"path" in final ? final.path : `not saved (${final.error})`}`,
        ]);
      }
      writeText(["", ...taskRunLogHints(run.id)]);
    }),
});

/** Builds `scarn logs`; tests pass fake dependencies. */
export function createLogsCommand(
  deps: TaskRunDebugDependencies = realTaskRunDebugDependencies,
): CommandModule<object, LogsArguments> {
  return buildLogsCommand(deps);
}

export const logsCommand = createLogsCommand();
