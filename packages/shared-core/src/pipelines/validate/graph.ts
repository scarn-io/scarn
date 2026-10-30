/**
 * Graph analysis for pipeline documents: the edge list, reachability,
 * dominance and reach-back checking (`checkReachBacks`). Splits and merges
 * are analysed in `splits.ts`.
 *
 * The graph has one vertex per node plus the start (`null`). Edges are the
 * start transition, every route in `next` (plus `otherwise`) and every
 * `catch` entry.
 */
import {
  routeEntries,
  type PipelineDocument,
  type PipelineNode,
} from "@scarn/sdk/contracts/pipeline-document";
import { closest, quoteList } from "./suggest";
import type { ValidationError } from "./types";

export type Segment = string | number;

export interface Edge {
  from: string | null;
  to: string;
  kind: "start" | "route" | "otherwise" | "catch";
  index: number;
  lane: "each" | "partial" | null;
  pointer: Segment[];
}

export interface PipelineGraph {
  nodes: Readonly<Record<string, PipelineNode>>;
  edges: Edge[];
  outgoing: Map<string | null, Edge[]>;
  incoming: Map<string, Edge[]>;
}

export function buildGraph(document: PipelineDocument): PipelineGraph {
  const edges: Edge[] = [];
  const { start } = document;
  edges.push({
    from: null,
    to: start.to,
    kind: "start",
    index: 0,
    lane: start.each ? "each" : null,
    pointer: ["start"],
  });
  for (const [id, node] of Object.entries(document.nodes)) {
    if (node.kind !== "step" && node.kind !== "wait") {
      continue;
    }
    for (const entry of routeEntries(node.next)) {
      edges.push({
        from: id,
        to: entry.route.to,
        kind: entry.kind,
        index: entry.index,
        lane: entry.route.each
          ? "each"
          : entry.route.partial
            ? "partial"
            : null,
        pointer: ["nodes", id, "next", ...entry.pointer],
      });
    }
    (node.catch ?? []).forEach((entry, index) => {
      edges.push({
        from: id,
        to: entry.to,
        kind: "catch",
        index,
        lane: null,
        pointer: ["nodes", id, "catch", index],
      });
    });
  }
  const known = edges.filter((edge) => Object.hasOwn(document.nodes, edge.to));
  const outgoing = new Map<string | null, Edge[]>();
  const incoming = new Map<string, Edge[]>();
  for (const edge of known) {
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge]);
    incoming.set(edge.to, [...(incoming.get(edge.to) ?? []), edge]);
  }
  return { nodes: document.nodes, edges: known, outgoing, incoming };
}

/** Nodes reachable from `starts` without ever entering `avoid`. */
export function reachableFrom(
  graph: PipelineGraph,
  starts: readonly (string | null)[],
  avoid?: string,
): Set<string> {
  const seen = new Set<string>();
  const queue = [...starts];
  const expanded = new Set<string | null>();
  while (queue.length > 0) {
    const current = queue.shift() as string | null;
    if (expanded.has(current)) {
      continue;
    }
    expanded.add(current);
    for (const edge of graph.outgoing.get(current) ?? []) {
      if (edge.to === avoid || seen.has(edge.to)) {
        continue;
      }
      seen.add(edge.to);
      queue.push(edge.to);
    }
  }
  return seen;
}

/** Whether every path from the start to `target` passes through `dominator`. */
export function dominates(
  graph: PipelineGraph,
  dominator: string,
  target: string,
): boolean {
  if (dominator === target) {
    return true;
  }
  return !reachableFrom(graph, [null], dominator).has(target);
}

/** The nodes that run on every path to `target`, in document order. */
export function dominatorsOf(graph: PipelineGraph, target: string): string[] {
  return Object.keys(graph.nodes).filter(
    (id) => id !== target && dominates(graph, id, target),
  );
}

/** A `nodes.<id>.result|input` reference found at a use site. */
export interface ReachBack {
  pointer: string;
  /** The node whose transition holds the reference; null for the start transition. */
  sourceId: string | null;
  site: "start" | "route" | "otherwise" | "catch";
  nodeId: string;
  source: "result" | "input";
  /** The splits whose lanes the transition's args and conditions are evaluated in, outermost first. */
  useScope: readonly string[];
}

/** Whether `scope` is `prefix` or nested inside it. */
export function isPrefix(
  prefix: readonly string[],
  scope: readonly string[],
): boolean {
  return (
    prefix.length <= scope.length &&
    prefix.every((id, index) => scope[index] === id)
  );
}

function scopeOf(scopes: ReadonlyMap<string, readonly string[]>, id: string) {
  return scopes.get(id) ?? [];
}

/** Whether a path from `from` to `target` leaves `from`'s lanes through a merge. */
function leavesLane(
  graph: PipelineGraph,
  scopes: ReadonlyMap<string, readonly string[]>,
  from: string,
  target: string,
) {
  const fromScope = scopeOf(scopes, from);
  if (fromScope.length === 0) {
    return false;
  }
  const seen = new Set<string>();
  const queue: [string, boolean][] = [[from, false]];
  while (queue.length > 0) {
    const [current, dipped] = queue.shift() as [string, boolean];
    for (const edge of graph.outgoing.get(current) ?? []) {
      const nextDipped =
        dipped || !isPrefix(fromScope, scopeOf(scopes, edge.to));
      if (edge.to === target && nextDipped) {
        return true;
      }
      const key = `${edge.to}:${String(nextDipped)}`;
      if (!seen.has(key)) {
        seen.add(key);
        queue.push([edge.to, nextDipped]);
      }
    }
  }
  return false;
}

function checkReachBack(
  graph: PipelineGraph,
  scopes: ReadonlyMap<string, readonly string[]>,
  reachBack: ReachBack,
): ValidationError | null {
  const { nodeId, sourceId, pointer, source } = reachBack;
  const ref = `nodes.${nodeId}.${source}`;
  const node = graph.nodes[nodeId];
  if (node === undefined) {
    const suggestion = closest(nodeId, Object.keys(graph.nodes));
    return {
      code: "unknown_node",
      path: pointer,
      message: `"${ref}" refers to a node that doesn't exist`,
      ...(suggestion === undefined
        ? {}
        : { hint: `Did you mean "nodes.${suggestion}.${source}"?` }),
    };
  }
  if (node.kind === "succeed" || node.kind === "fail") {
    return {
      code: "reach_back",
      path: pointer,
      message: `"${nodeId}" is a ${node.kind} node; it has no ${source} to reach back to`,
    };
  }
  if (sourceId === null) {
    return {
      code: "reference_not_allowed",
      path: pointer,
      message: `The start transition can't reach back to "${nodeId}": no node has run yet`,
      hint: 'Use "workItem.title", "workItem.description", "workItem.fields.<alias>" or { "value": ... }',
    };
  }
  if (nodeId === sourceId) {
    if (reachBack.site === "catch" && source === "result") {
      return {
        code: "reach_back",
        path: pointer,
        message: `"${nodeId}" failed, so it has no result inside its own catch`,
        hint: 'Use "error" or "input" instead',
      };
    }
    if (!isPrefix(scopeOf(scopes, nodeId), reachBack.useScope)) {
      return afterMerge(nodeId, pointer);
    }
    return null;
  }
  if (!dominates(graph, nodeId, sourceId)) {
    const candidates = dominatorsOf(graph, sourceId).filter((id) => {
      const kind = graph.nodes[id]?.kind;
      return kind === "step" || kind === "wait";
    });
    return {
      code: "reach_back",
      path: pointer,
      message: `"${nodeId}" doesn't run on every path to "${sourceId}", so "${ref}" may not exist`,
      hint:
        candidates.length > 0
          ? `Reach back to a node that runs on every path to "${sourceId}" (${quoteList(candidates)}), or pass the value along in args`
          : "Pass the value along in args",
    };
  }
  if (source === "result") {
    const catchTargets = (graph.outgoing.get(nodeId) ?? [])
      .filter((edge) => edge.kind === "catch")
      .map((edge) => edge.to);
    const viaCatch =
      catchTargets.includes(sourceId) ||
      reachableFrom(graph, catchTargets, nodeId).has(sourceId);
    if (viaCatch) {
      return {
        code: "reach_back",
        path: pointer,
        message: `"${sourceId}" can be reached after "${nodeId}" failed (through its catch), so "${ref}" may not exist`,
        hint: `Reach back to "nodes.${nodeId}.input" instead, or don't route the catch here`,
      };
    }
  }
  if (
    !isPrefix(scopeOf(scopes, nodeId), reachBack.useScope) ||
    leavesLane(graph, scopes, nodeId, sourceId)
  ) {
    return afterMerge(nodeId, pointer);
  }
  return null;
}

function afterMerge(nodeId: string, pointer: string): ValidationError {
  return {
    code: "split",
    path: pointer,
    message: `"${nodeId}" runs in a split's lanes, and this reference is evaluated after they merged`,
    hint: 'Pass per-item values to the merge with a "partial" route, then read them from "input"',
  };
}

/** Checks that each reach-back names a node that ran on every path to the use site, in the same lane. */
export function checkReachBacks(
  graph: PipelineGraph,
  scopes: ReadonlyMap<string, readonly string[]>,
  reachBacks: readonly ReachBack[],
): ValidationError[] {
  return reachBacks
    .map((reachBack) => checkReachBack(graph, scopes, reachBack))
    .filter((error): error is ValidationError => error !== null);
}
