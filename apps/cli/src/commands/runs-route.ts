import type { ArgumentsCamelCase, Argv, CommandModule } from "yargs";
import {
  describeRouteOption,
  describeTransitions,
  formatOverrulePreview,
  formatRouteContext,
  loadRouteContext,
  overruleRoute,
  planOverrule,
  previewOverrule,
  RouteRefusal,
  type RouteChoice,
  type RouteContext,
  type RouteOption,
} from "@scarn/shared-core";
import { asCliAction, parseAttempt } from "../lib/action-support";
import { CliError } from "../lib/cli-error";
import { withReporter } from "../lib/command-output";
import { withConfirmOption } from "../lib/confirm-action";
import { withBaseUrlOption } from "../lib/connect-project";
import { nextHint, writeJson, writeText } from "../lib/output";
import { readBody } from "../lib/read-body";
import type { RunActionDependencies } from "./runs-actions";

/**
 * `scarn runs route`: lists the routes a step visit took and could take, or
 * overrules them with a reason after previewing what changes.
 */

interface RouteArguments {
  runId: string;
  json: boolean;
  baseUrl: string | undefined;
  step: string;
  attempt: number | undefined;
  to: string | undefined;
  label: string | undefined;
  otherwise: boolean;
  add: string[] | undefined;
  remove: string[] | undefined;
  reason: string | undefined;
  /** `--accept-missing`; yargs adds the camel-case key at runtime. */
  acceptMissing?: boolean;
  yes: boolean;
}

const FIRST_FLAGS = "--to <node> | --label <label> | --otherwise";
const ALL_FLAGS = "--add <label|node>... --remove <label|node>...";

function choiceOf(args: RouteArguments): RouteChoice | undefined {
  const add = args.add ?? [];
  const remove = args.remove ?? [];
  const picks: RouteChoice[] = [
    ...(args.to === undefined ? [] : [{ kind: "to", node: args.to } as const]),
    ...(args.label === undefined
      ? []
      : [{ kind: "label", label: args.label } as const]),
    ...(args.otherwise ? [{ kind: "otherwise" } as const] : []),
  ];
  const changes = add.length + remove.length > 0;
  if (picks.length + (changes ? 1 : 0) > 1) {
    throw new CliError(
      "invalid_usage",
      `Pass one of --to, --label or --otherwise (match: first), or --add/--remove (match: all).`,
    );
  }
  return changes ? { kind: "change", add, remove } : picks[0];
}

function checkMode(
  args: RouteArguments,
  context: RouteContext,
  choice: RouteChoice,
): void {
  const base = `scarn runs route ${args.runId} --step ${args.step}`;
  if (context.match === "all" && choice.kind !== "change") {
    throw new CliError(
      "invalid_usage",
      `Step "${args.step}" takes every matching route (match: all), so add or remove routes instead:\n  ${base} ${ALL_FLAGS} --reason <text>`,
    );
  }
  if (context.match === "first" && choice.kind === "change") {
    throw new CliError(
      "invalid_usage",
      `Step "${args.step}" takes one route (match: first), so pick the route to take instead:\n  ${base} (${FIRST_FLAGS}) --reason <text>`,
    );
  }
}

const quote = (value: string) =>
  /^[\w@./:-]+$/u.test(value) ? value : `'${value.replace(/'/gu, `'\\''`)}'`;

function rerunWithAcceptMissing(args: RouteArguments): string {
  const parts = ["scarn runs route", args.runId, "--step", quote(args.step)];
  if (args.attempt !== undefined) parts.push("--attempt", String(args.attempt));
  if (args.to !== undefined) parts.push("--to", quote(args.to));
  if (args.label !== undefined) parts.push("--label", quote(args.label));
  if (args.otherwise) parts.push("--otherwise");
  for (const add of args.add ?? []) parts.push("--add", quote(add));
  for (const remove of args.remove ?? []) parts.push("--remove", quote(remove));
  parts.push("--reason", quote(args.reason ?? ""), "--accept-missing");
  return parts.join(" ");
}

function explainRefusal(
  args: RouteArguments,
  context: RouteContext,
  refusal: RouteRefusal,
): CliError {
  const lines = [refusal.message];
  if (refusal.code === "PIPELINE_RUN_ROUTE_ARGS_MISSING") {
    lines.push(
      "Missing args:",
      ...refusal.missing.map((arg) => `  ${arg.arg} (${arg.reference})`),
    );
    if (args.acceptMissing !== true) {
      lines.push(
        "To start the route without them:",
        `  ${rerunWithAcceptMissing(args)}`,
      );
    }
  }
  if (refusal.code === "PIPELINE_RUN_ROUTE_NOT_OVERRIDABLE") {
    lines.push(
      `Not overridable: ${describeTransitions(context, refusal.routes)}`,
      "Rerun the step instead:",
      `  scarn runs rerun ${args.runId} --step ${args.step}`,
    );
  }
  return new CliError("action_rejected", lines.join("\n"), {
    cause: refusal,
  });
}

function listingHints(args: RouteArguments, context: RouteContext): string[] {
  const base = `scarn runs route ${args.runId} --step ${args.step}`;
  if (!context.options.some((option) => option.overridable)) {
    return [nextHint(`scarn runs rerun ${args.runId} --step ${args.step}`)];
  }
  return [
    nextHint(
      context.match === "all"
        ? `${base} ${ALL_FLAGS} --reason <text>`
        : `${base} (${FIRST_FLAGS}) --reason <text>`,
    ),
  ];
}

const appliedText = (
  args: RouteArguments,
  context: RouteContext,
  options: RouteOption[],
) => [
  `Overruled step "${args.step}" (visit ${context.target.visit.id}): it now takes ${options.length === 0 ? "no route" : options.map((option) => option.to).join(", ")}.`,
  ...[...new Set(options.map((option) => option.to))].map((node) =>
    nextHint(`scarn runs thread ${args.runId} --step ${node}`),
  ),
];

async function readReason(args: RouteArguments, deps: RunActionDependencies) {
  if (args.reason === undefined) {
    throw new CliError(
      "invalid_usage",
      "--reason is required to overrule a route.",
    );
  }
  try {
    return await readBody(args.reason, deps.io.body);
  } catch (error) {
    if (error instanceof CliError && error.code === "invalid_usage") {
      throw new CliError("invalid_usage", "--reason is empty.");
    }
    throw error;
  }
}

export const routeCommand = (
  deps: RunActionDependencies,
): CommandModule<object, RouteArguments> => ({
  command: "route <runId>",
  describe:
    "Show the routes a step took and could take, or overrule them with a reason (asks first)",
  builder: (argv: Argv<object>) =>
    withConfirmOption(withBaseUrlOption(argv))
      .positional("runId", {
        describe: "The pipeline run ID",
        type: "string",
        demandOption: true,
      })
      .option("json", {
        describe: "Print the API response as a single JSON document",
        type: "boolean",
        default: false,
      })
      .option("step", {
        describe: "The step key whose routes to show or overrule",
        type: "string",
        demandOption: true,
      })
      .option("attempt", {
        describe:
          "Which visit to the step, 1 for the first (defaults to the latest)",
        type: "number",
      })
      .option("to", {
        describe: "match: first — take the route to this node",
        type: "string",
      })
      .option("label", {
        describe: "match: first — take the route with this label",
        type: "string",
      })
      .option("otherwise", {
        describe: "match: first — take the otherwise route",
        type: "boolean",
        default: false,
      })
      .option("add", {
        describe: "match: all — also take this route (label or target node)",
        type: "string",
        array: true,
      })
      .option("remove", {
        describe: "match: all — stop taking this route (label or target node)",
        type: "string",
        array: true,
      })
      .option("reason", {
        describe:
          "Why you overrule the route: text, @path to read a file, or - for stdin",
        type: "string",
        nargs: 1,
      })
      .option("accept-missing", {
        describe:
          "Start the routes even when some of their args resolve to nothing",
        type: "boolean",
        default: false,
      }),
  handler: (args: ArgumentsCamelCase<RouteArguments>) =>
    withReporter("runs-route", ({ reporter }) =>
      asCliAction(async () => {
        const attempt = parseAttempt(args.attempt);
        const choice = choiceOf(args);
        const reason =
          choice === undefined ? undefined : await readReason(args, deps);
        const { client } = await deps.connect(args);
        const connection = { client, runId: args.runId };
        const context = await loadRouteContext({
          ...connection,
          stepKey: args.step,
          attempt,
        });
        if (choice === undefined || reason === undefined) {
          if (args.json) writeJson(context.target.visit.routing);
          else
            writeText([
              ...formatRouteContext(context),
              ...listingHints(args, context),
            ]);
          return;
        }
        checkMode(args, context, choice);
        const plan = planOverrule(context, choice);
        const request = {
          ...connection,
          visitId: context.target.visit.id,
          stepKey: args.step,
          routes: plan.routes,
          reason,
          acceptMissing: args.acceptMissing ?? false,
        };
        try {
          const preview = await previewOverrule(request);
          const question = [
            `Overrule step "${args.step}" of pipeline run ${args.runId} to take ${plan.options.map(describeRouteOption).join(", ") || "no route"}?`,
            ...formatOverrulePreview(context, preview),
          ].join("\n");
          if (!(await deps.io.confirm(question, args.yes))) {
            reporter.info("Nothing was overruled.");
            return;
          }
          const run = await overruleRoute(request);
          if (args.json) writeJson(run);
          else writeText(appliedText(args, context, plan.options));
        } catch (error) {
          if (error instanceof RouteRefusal) {
            throw explainRefusal(args, context, error);
          }
          throw error;
        }
      }),
    ),
});
