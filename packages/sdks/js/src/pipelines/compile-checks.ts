/**
 * Whole-graph checks run after every chain is wired: unreachable nodes,
 * decisions without actions, reach-backs to missing nodes, unused reads,
 * work-item field labels, and chains left out of `flow`. Split checks (scopes, merges, reach-backs into
 * merged lanes) run in shared-core's validator.
 */
import { issue, type CompileState } from "./compile-state";
import type { BuildIssue } from "./errors";
import { pendingChains } from "./registry";
import { unusedReads } from "./refs";

interface RouteJson {
  to?: string;
}

function targetsOf(json: Record<string, unknown>): string[] {
  const next = json["next"] as
    { routes?: RouteJson[]; otherwise?: RouteJson } | undefined;
  const entries = [
    ...(next?.routes ?? []),
    ...(next?.otherwise === undefined ? [] : [next.otherwise]),
    ...((json["catch"] as RouteJson[] | undefined) ?? []),
  ];
  return entries.flatMap((entry) => (entry.to === undefined ? [] : [entry.to]));
}

export function checkReachable(
  state: CompileState,
  start: string | undefined,
): void {
  const seen = new Set<string>();
  const queue = start === undefined ? [] : [start];
  while (queue.length > 0) {
    const id = queue.shift() ?? "";
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    const placed = state.nodes.get(id);
    if (placed !== undefined) {
      queue.push(...targetsOf(placed.json));
    }
  }
  for (const [id, placed] of state.nodes) {
    if (!seen.has(id)) {
      issue(
        state,
        placed.chain?.site ?? placed.def.site,
        ["nodes", id],
        `"${id}" is unreachable: nothing targets it from start`,
      );
    }
  }
}

export function checkDecisionActions(state: CompileState): void {
  for (const [id, placed] of state.nodes) {
    const def = placed.def;
    if (
      def.kind === "wait" &&
      def.for === "decision" &&
      (def.actions ?? []).length === 0
    ) {
      issue(
        state,
        def.site,
        ["nodes", id, "actions"],
        `decision "${id}" has no actions; give it at least one, such as { approve: { label: "Approve" } }`,
      );
    }
  }
}

export function checkReaches(state: CompileState): void {
  for (const use of state.tracker.reaches) {
    if (!state.nodes.has(use.node)) {
      state.issues.push({
        site: use.site,
        pointer: use.pointer,
        message: `r.node(...) reaches back to "${use.node}", which isn't in this pipeline`,
      });
    }
  }
}

export function checkUnusedReads(state: CompileState): void {
  for (const record of unusedReads(state.tracker)) {
    state.issues.push({
      site: record.site,
      pointer: record.pointer,
      message: `"${record.path}" is read but never used in an arg, each or condition. JS logic on placeholders (?:, &&, ||, !, if) runs once at build time and picks one branch; use a condition helper in a .next(...) route's when`,
    });
  }
}

/** The `workItemFields` map, from the fields used, in order of first use. */
export function workItemFields(
  state: CompileState,
): Record<string, string> | undefined {
  const fields: Record<string, string> = {};
  for (const field of state.tracker.fields) {
    const existing = fields[field.alias];
    if (existing !== undefined && existing !== field.label) {
      issue(
        state,
        null,
        ["workItemFields", field.alias],
        `work-item field "${field.alias}" is used with two labels: "${existing}" and "${field.label}"`,
      );
    } else {
      fields[field.alias] = field.label;
    }
  }
  return Object.keys(fields).length === 0 ? undefined : fields;
}

/** Finished chains for this pipeline's nodes that were never put in a flow. */
export function unusedChainWarnings(state: CompileState): BuildIssue[] {
  const warnings: BuildIssue[] = [];
  for (const chain of pendingChains) {
    const placed = state.nodes.get(chain.node.id);
    if (state.usedChains.has(chain)) {
      pendingChains.delete(chain);
    } else if (placed !== undefined && placed.def === chain.node) {
      pendingChains.delete(chain);
      warnings.push({
        site: chain.site,
        pointer: `/nodes/${chain.node.id}`,
        message: `a chain for "${chain.node.id}" was built but never put in flow, so it has no effect`,
      });
    }
  }
  return warnings;
}
