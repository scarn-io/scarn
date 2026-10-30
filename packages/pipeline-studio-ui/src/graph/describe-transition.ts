/**
 * Short, human-readable edge labels for pipeline document transitions:
 * route conditions, `otherwise`, `each`/`partial` lane markers and `catch` error
 * names. Pure and React-free so the worker and tests can use it directly.
 */
import type {
  Catch,
  Condition,
  Otherwise,
  Route,
  RouteKind,
} from "@scarn/sdk/contracts/pipeline-document";

const MAX_LABEL_LENGTH = 48;

const OPERATOR_SYMBOLS: Partial<Record<string, string>> = {
  equal: "==",
  notEqual: "!=",
  lessThan: "<",
  lessThanInclusive: "<=",
  greaterThan: ">",
  greaterThanInclusive: ">=",
};

function truncate(text: string): string {
  return text.length > MAX_LABEL_LENGTH
    ? `${text.slice(0, MAX_LABEL_LENGTH - 1)}…`
    : text;
}

function describeLeft(condition: Condition): string {
  if (condition.path !== undefined) return condition.path;
  for (const fn of ["sum", "avg", "min", "max", "count"] as const) {
    const source = condition[fn];
    if (source === undefined) continue;
    const inner = Array.isArray(source) ? source.join(", ") : source.path;
    return `${fn}(${inner})`;
  }
  return "?";
}

function describeRight(condition: Condition): string {
  if (condition.ref !== undefined) return condition.ref;
  if (condition.value !== undefined) return JSON.stringify(condition.value);
  return "";
}

/** One line summarizing a `when` condition, e.g. `result.score >= 7 and result.ok == true`. */
export function describeCondition(condition: Condition): string {
  if (condition.all) return condition.all.map(describeCondition).join(" and ");
  if (condition.any) return condition.any.map(describeCondition).join(" or ");
  if (condition.not) return `not (${describeCondition(condition.not)})`;
  const op = condition.op ?? "";
  const right =
    condition.where !== undefined
      ? `(${describeCondition(condition.where)})`
      : describeRight(condition);
  return [describeLeft(condition), OPERATOR_SYMBOLS[op] ?? op, right]
    .filter((part) => part !== "")
    .join(" ");
}

/**
 * The label for one route of `next` (or the `start` transition): its `when`
 * condition, `always` for a route without `when` on a `match: "all"` node,
 * or `otherwise` for the fallback route, then any `each` or `partial`
 * marker. A lone route without `when` on a `first` node has no condition
 * label.
 */
export function describeRoute(
  route: Route | Otherwise,
  kind: RouteKind | "start",
  match: "first" | "all" = "first",
): string | undefined {
  const parts: string[] = [];
  if (kind === "otherwise") {
    parts.push("otherwise");
  } else if ("when" in route && route.when) {
    parts.push(describeCondition(route.when));
  } else if (kind === "route" && match === "all") {
    parts.push("always");
  }
  if (route.each) parts.push(`each over ${route.each.over}`);
  if ("partial" in route && route.partial) {
    const fields = Object.keys(route.args ?? {});
    parts.push(fields.length > 0 ? `partial: ${fields.join(", ")}` : "partial");
  }
  return parts.length > 0 ? truncate(parts.join(" · ")) : undefined;
}

export function describeCatch(entry: Catch): string {
  return truncate(`catch ${entry.on.join(", ")}`);
}
