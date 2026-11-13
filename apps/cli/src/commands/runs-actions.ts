import type { ArgumentsCamelCase, Argv, CommandModule } from "yargs";
import {
  cancelRun,
  loadRun,
  messageStep,
  planRerun,
  rerunVisits,
  type RerunResult,
  type RunActionClient,
  type TargetVisit,
} from "@scarn/shared-core";
import { resolveScarnBaseUrl } from "@scarn/worker";
import {
  asCliAction,
  parseAttempt,
  realActionIo,
  type ActionIo,
} from "../lib/action-support";
import { connectApi, type AuthenticatedApi } from "../lib/cli-api-client";
import { CliError } from "../lib/cli-error";
import { withReporter } from "../lib/command-output";
import { withConfirmOption } from "../lib/confirm-action";
import { withBaseUrlOption } from "../lib/connect-project";
import { nextHint, writeJson, writeText } from "../lib/output";
import { readBody } from "../lib/read-body";

/**
 * `scarn runs rerun`, `runs message` and `runs cancel`: the safe actions on a
 * pipeline run. Rerun and cancel ask first; message does not.
 */

type ActionConnection = {
  client: RunActionClient;
  headers: { Authorization: string };
};

/** What the action verbs reach the API and the terminal through. */
export interface RunActionDependencies {
  connect(args: { baseUrl: string | undefined }): Promise<ActionConnection>;
  io: ActionIo;
}

/** The generated client matches {@link RunActionClient} only at runtime. */
const asActionClient = (client: AuthenticatedApi["client"]) =>
  client as unknown as RunActionClient;

export const realRunActionDependencies: RunActionDependencies = {
  async connect(args) {
    const api = await connectApi(resolveScarnBaseUrl(args.baseUrl));
    return { client: asActionClient(api.client), headers: api.headers };
  },
  io: realActionIo,
};

interface RunArguments {
  runId: string;
  json: boolean;
  baseUrl: string | undefined;
}

const withRunArguments = <T>(argv: Argv<T>) =>
  withBaseUrlOption(argv)
    .positional("runId", {
      describe: "The pipeline run ID",
      type: "string",
      demandOption: true,
    })
    .option("json", {
      describe: "Print the API response as a single JSON document",
      type: "boolean",
      default: false,
    });

const describeTarget = (target: TargetVisit) =>
  `step "${target.stepKey}" attempt ${String(target.attemptNumber)} (visit ${target.visit.id}, ${target.visit.status})`;

const threadHint = (runId: string, stepKey: string) =>
  nextHint(`scarn runs thread ${runId} --step ${stepKey}`);

// rerun

interface RerunArguments extends RunArguments {
  step: string | undefined;
  attempt: number | undefined;
  failed: boolean;
  yes: boolean;
}

function rerunText(runId: string, result: RerunResult): string[] {
  const lines = result.outcomes.map((outcome) =>
    outcome.status === "rerun"
      ? `Reran ${describeTarget(outcome.target)} → new visit ${outcome.newVisitId ?? "(pending)"}`
      : `Skipped ${describeTarget(outcome.target)}: ${outcome.reason}`,
  );
  const first = result.outcomes.find((outcome) => outcome.status === "rerun");
  if (first !== undefined) lines.push(threadHint(runId, first.target.stepKey));
  return lines;
}

const rerunCommand = (
  deps: RunActionDependencies,
): CommandModule<object, RerunArguments> => ({
  command: "rerun <runId>",
  describe: "Rerun a step of a pipeline run, or every failed step (asks first)",
  builder: (argv: Argv<object>) =>
    withConfirmOption(withRunArguments(argv))
      .option("step", {
        describe: "The step key to rerun",
        type: "string",
      })
      .option("attempt", {
        describe:
          "Which visit to the step, 1 for the first (defaults to the latest)",
        type: "number",
      })
      .option("failed", {
        describe: "Rerun every failed step of the run",
        type: "boolean",
        default: false,
      }),
  handler: (args: ArgumentsCamelCase<RerunArguments>) =>
    withReporter("runs-rerun", ({ reporter }) =>
      asCliAction(async () => {
        if ((args.step === undefined) === !args.failed) {
          throw new CliError(
            "invalid_usage",
            "Pass exactly one of --step <key> or --failed.",
          );
        }
        if (args.failed && args.attempt !== undefined) {
          throw new CliError(
            "invalid_usage",
            "--attempt only goes with --step.",
          );
        }
        const attempt = parseAttempt(args.attempt);
        const { client, headers } = await deps.connect(args);
        const connection = { client, headers, runId: args.runId };
        const run = await loadRun(connection);
        const targets = planRerun(
          run,
          args.step === undefined
            ? { kind: "failed" }
            : { kind: "step", stepKey: args.step, attempt },
        );
        const question = [
          `Rerun ${String(targets.length)} visit(s) of pipeline run ${args.runId}? Each supersedes every visit downstream of it.`,
          ...targets.map((target) => `  ${describeTarget(target)}`),
        ].join("\n");
        if (!(await deps.io.confirm(question, args.yes))) {
          reporter.info("Nothing was rerun.");
          return;
        }
        const result = await rerunVisits({ ...connection, run, targets });
        if (args.json) writeJson(result.run);
        else writeText(rerunText(args.runId, result));
      }),
    ),
});

// message

interface MessageArguments extends RunArguments {
  step: string;
  attempt: number | undefined;
  body: string;
}

const messageCommand = (
  deps: RunActionDependencies,
): CommandModule<object, MessageArguments> => ({
  command: "message <runId>",
  describe:
    "Send a message to a step; it reruns with a new Task carrying the message",
  builder: (argv: Argv<object>) =>
    withRunArguments(argv)
      .option("step", {
        describe: "The step key to message",
        type: "string",
        demandOption: true,
      })
      .option("attempt", {
        describe:
          "Which visit to the step, 1 for the first (defaults to the latest)",
        type: "number",
      })
      .option("body", {
        describe: "The message: text, @path to read a file, or - for stdin",
        type: "string",
        nargs: 1,
        demandOption: true,
      }),
  handler: (args: ArgumentsCamelCase<MessageArguments>) =>
    withReporter("runs-message", () =>
      asCliAction(async () => {
        const attempt = parseAttempt(args.attempt);
        const body = await readBody(args.body, deps.io.body);
        const { client, headers } = await deps.connect(args);
        const { target, sent } = await messageStep({
          client,
          headers,
          runId: args.runId,
          stepKey: args.step,
          attempt,
          body,
        });
        if (args.json) {
          writeJson(sent);
          return;
        }
        writeText([
          `Sent message ${sent.message.id} to ${describeTarget(target)}.`,
          `New Task: ${sent.message.taskId}`,
          threadHint(args.runId, args.step),
          nextHint(`scarn tasks view ${sent.message.taskId}`),
        ]);
      }),
    ),
});

// cancel

interface CancelArguments extends RunArguments {
  yes: boolean;
}

const cancelCommand = (
  deps: RunActionDependencies,
): CommandModule<object, CancelArguments> => ({
  command: "cancel <runId>",
  describe: "Cancel a pipeline run and its open Tasks (asks first)",
  builder: (argv: Argv<object>) => withConfirmOption(withRunArguments(argv)),
  handler: (args: ArgumentsCamelCase<CancelArguments>) =>
    withReporter("runs-cancel", ({ reporter }) =>
      asCliAction(async () => {
        const { client, headers } = await deps.connect(args);
        const connection = { client, headers, runId: args.runId };
        const run = await loadRun(connection);
        const question = `Cancel pipeline run ${run.id} (${run.status}) of "${run.workItemTitle}"?`;
        if (!(await deps.io.confirm(question, args.yes))) {
          reporter.info("Nothing was cancelled.");
          return;
        }
        const cancelled = await cancelRun(connection);
        if (args.json) {
          writeJson(cancelled);
          return;
        }
        writeText([
          `Cancelled pipeline run ${cancelled.id} (now ${cancelled.status}).`,
          nextHint(`scarn runs list --work-item ${cancelled.workItemId}`),
        ]);
      }),
    ),
});

/** Registers the action verbs on `scarn runs`, next to the reads. */
export const withRunActionCommands = (
  argv: Argv<object>,
  deps: RunActionDependencies,
) =>
  argv
    .command(rerunCommand(deps))
    .command(messageCommand(deps))
    .command(cancelCommand(deps));
