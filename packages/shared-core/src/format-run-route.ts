import type { JsonValue } from "@scarn/sdk/contracts/pipeline-document";
import type { ConditionRecord } from "./pipelines/conditions/evaluate";
import type { OverrulePreview, VisitTransition } from "./lib/route-api-types";
import {
  describeRouteOption,
  type RouteContext,
  type RouteOption,
} from "./run-route";

/**
 * Text for `scarn runs route`: the routes a step visit took and why, the
 * routes it could take instead, and the summary of an overrule's preview.
 */

const json = (value: JsonValue | null) => JSON.stringify(value);

/** `result.verdict equal "rejected" (was "approved")`, or `all(…)` for groups. */
export function describeCondition(record: ConditionRecord): string {
  switch (record.kind) {
    case "all":
    case "any":
      return `${record.kind}(${record.conditions.map(describeCondition).join(", ")})`;
    case "not":
      return `not(${describeCondition(record.condition)})`;
    case "list":
      return `${record.path} ${record.op} (${String(record.matchedIndexes.length)} of ${String(record.length)} matched)`;
    case "compare": {
      const left = record.left.path ?? record.left.computed ?? "value";
      const right =
        record.right === undefined
          ? ""
          : ` ${record.right.ref ?? json(record.right.value)}`;
      return `${left} ${record.op}${right} (was ${json(record.left.value)})`;
    }
  }
}

function reasonFor(option: RouteOption): string {
  if (option.kind === "otherwise") return "taken when no route with a when is";
  if (!option.conditional) return "no when, always runs";
  if (option.checked?.when == null) return "not checked";
  const verdict = option.checked.matched ? "matched" : "did not match";
  return `${verdict}: ${describeCondition(option.checked.when)}`;
}

function optionLine(option: RouteOption): string {
  const marks = [
    option.taken ? "taken" : "",
    option.overridable ? "overridable" : "not overridable",
  ].filter((mark) => mark !== "");
  return `  ${option.taken ? "●" : "○"} ${describeRouteOption(option)}  [${marks.join(", ")}]\n      ${reasonFor(option)}`;
}

/** `routes[1] "fix" → fix, otherwise → done`, or `(path ended)`. */
export const describeTransitions = (
  context: RouteContext,
  transitions: readonly VisitTransition[],
): string =>
  transitions.length === 0
    ? "(path ended)"
    : transitions
        .map((transition) => {
          const option = context.options.find(
            (candidate) =>
              candidate.kind === transition.kind &&
              candidate.index === transition.index,
          );
          return option === undefined
            ? `${transition.kind}[${String(transition.index)}]`
            : describeRouteOption(option);
        })
        .join(", ");

/** The listing `scarn runs route <runId> --step <key>` prints. */
export function formatRouteContext(context: RouteContext): string[] {
  const { target } = context;
  const lines = [
    `Step "${target.stepKey}" attempt ${String(target.attemptNumber)} (visit ${target.visit.id}, ${target.visit.status}), match: ${context.match}`,
    `Took: ${context.taken === null ? "(not routed yet)" : describeTransitions(context, context.taken)}`,
    "",
    "Routes:",
    ...(context.options.length === 0
      ? ["  (the step has no next routes)"]
      : context.options.map(optionLine)),
  ];
  if (context.overrules.length > 0) {
    lines.push("", "Overrules:");
    for (const overrule of context.overrules) {
      lines.push(
        `  ${overrule.at}: ${describeTransitions(context, overrule.from)} ⇒ ${describeTransitions(context, overrule.to)} — ${overrule.reason}`,
      );
    }
  }
  return lines;
}

const laneName = (
  context: RouteContext,
  lane: OverrulePreview["lanesAdded"][number],
) => lane.label ?? describeTransitions(context, [lane.route]);

const list = (items: readonly string[]) =>
  items.length === 0 ? "none" : items.join(", ");

/** The preview lines the confirmation question shows. */
export function formatOverrulePreview(
  context: RouteContext,
  preview: OverrulePreview,
): string[] {
  const lines = [
    `  Starts: ${list(preview.started)}`,
    `  Visits superseded: ${list(preview.superseded.map((visit) => `${visit.nodeId} (${visit.status})`))}`,
    `  Tasks cancelled: ${String(preview.cancelledTasks)}`,
  ];
  if (context.match === "all") {
    lines.push(
      `  Lanes started: ${list(preview.lanesAdded.map((lane) => laneName(context, lane)))}`,
      `  Lanes cancelled: ${list(preview.lanesRemoved.map((lane) => laneName(context, lane)))}`,
      `  Merges that run again: ${list(preview.mergesRerun)}`,
    );
  }
  lines.push(`  Reopens the run: ${preview.reopensRun ? "yes" : "no"}`);
  if (preview.missing.length > 0) {
    lines.push(
      `  Args accepted as missing: ${preview.missing.map((arg) => `${arg.arg} (${arg.reference})`).join(", ")}`,
    );
  }
  return lines;
}
