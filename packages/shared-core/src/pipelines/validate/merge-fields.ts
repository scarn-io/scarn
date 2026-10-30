/**
 * The fields a merge's partial routes supply: which lanes supply each one,
 * and whether it's guaranteed to arrive. A field is guaranteed when it comes
 * from item lanes (it defaults to `[]`), or when a route of its origin that
 * always runs supplies it on every path that doesn't fail.
 */
import {
  jsonPointer,
  type Next,
  type Otherwise,
  type Route,
} from "@scarn/sdk/contracts/pipeline-document";
import { reachableFrom, type Edge, type PipelineGraph } from "./graph";
import type { ValidationError } from "./types";

/** One input field of a merge and the partial routes that supply it. */
export interface MergeField {
  name: string;
  edges: Edge[];
  /** The split whose lanes supply the field. */
  split: string;
  /** The routes of that split the supplying lanes come from. */
  origin: string[];
  /** Fields from item lanes are arrays, concatenated in item order. */
  fromEach: boolean;
  /** Whether the field always arrives (fields from item lanes default to `[]`). */
  guaranteed: boolean;
}

/** Where a partial route's lane comes from. */
export interface EdgeSource {
  split: string;
  kind: "each" | "all";
  origin: ReadonlySet<string>;
  /** The routes of the split, keyed by route id. */
  routes: ReadonlyMap<string, Edge>;
}

export function routeOf(
  graph: PipelineGraph,
  edge: Edge,
): Route | Otherwise | undefined {
  const node = graph.nodes[edge.from ?? ""];
  if (node?.kind !== "step" && node?.kind !== "wait") {
    return undefined;
  }
  if (edge.kind === "otherwise") {
    return node.next?.otherwise;
  }
  return edge.kind === "route" ? node.next?.routes[edge.index] : undefined;
}

function suppliesField(graph: PipelineGraph, edge: Edge, name: string) {
  return (
    edge.lane === "partial" &&
    Object.hasOwn(routeOf(graph, edge)?.args ?? {}, name)
  );
}

function canEndQuietly(next: Next): boolean {
  return (
    next.otherwise === undefined &&
    next.routes.every((route) => route.when !== undefined)
  );
}

/**
 * Whether every path from `entry` either fails or reaches `mergeId` through a
 * route that supplies `name`. Loops that never leave don't count against it.
 */
function alwaysSupplies(
  graph: PipelineGraph,
  entry: Edge,
  mergeId: string,
  name: string,
): boolean {
  const ok = new Map<string, boolean>();
  const edgeOk = (edge: Edge) =>
    edge.to === mergeId
      ? suppliesField(graph, edge, name)
      : ok.get(edge.to) === true;
  const holds = (nodeId: string): boolean => {
    const node = graph.nodes[nodeId];
    if (node?.kind === "fail") {
      return true;
    }
    if (node?.kind !== "step" && node?.kind !== "wait") {
      return false;
    }
    if (node.next === undefined || canEndQuietly(node.next)) {
      return false;
    }
    return (graph.outgoing.get(nodeId) ?? []).every(edgeOk);
  };
  if (entry.to === mergeId) {
    return suppliesField(graph, entry, name);
  }
  const nodes = reachableFrom(graph, [entry.to], mergeId);
  nodes.add(entry.to);
  for (const id of nodes) {
    ok.set(id, true);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of nodes) {
      if (ok.get(id) === true && !holds(id)) {
        ok.set(id, false);
        changed = true;
      }
    }
  }
  return ok.get(entry.to) === true;
}

function isGuaranteed(
  graph: PipelineGraph,
  source: EdgeSource,
  mergeId: string,
  name: string,
): boolean {
  if (source.kind === "each") {
    return true;
  }
  return [...source.origin].some((routeId) => {
    const edge = source.routes.get(routeId);
    if (edge === undefined || edge.kind !== "route") {
      return false;
    }
    const route = routeOf(graph, edge);
    return (
      route !== undefined &&
      !("when" in route && route.when !== undefined) &&
      alwaysSupplies(graph, edge, mergeId, name)
    );
  });
}

function originKey(source: EdgeSource): string {
  return `${source.split}|${[...source.origin].sort().join(",")}`;
}

/** Collects the merge's fields from its partial routes, reporting fields supplied by lanes from different routes. */
export function collectFields(
  graph: PipelineGraph,
  mergeId: string,
  incoming: readonly Edge[],
  sourceOf: (edge: Edge) => EdgeSource | undefined,
  errors: ValidationError[],
): Map<string, MergeField> {
  const fields = new Map<string, MergeField>();
  const keys = new Map<string, string>();
  for (const edge of incoming) {
    const source = sourceOf(edge);
    if (source === undefined) {
      continue;
    }
    const key = originKey(source);
    for (const name of Object.keys(routeOf(graph, edge)?.args ?? {})) {
      const existing = fields.get(name);
      if (existing !== undefined && keys.get(name) !== key) {
        errors.push({
          code: "split",
          path: jsonPointer([...edge.pointer, "args", name]),
          message: `"${name}" is already supplied to "${mergeId}" by lanes from other routes (${existing.origin.map((id) => `"${id}"`).join(", ")})`,
          hint: "Supply each field of a merge from one route only, or rename one of them",
        });
        continue;
      }
      if (existing !== undefined) {
        existing.edges.push(edge);
        continue;
      }
      keys.set(name, key);
      fields.set(name, {
        name,
        edges: [edge],
        split: source.split,
        origin: [...source.origin],
        fromEach: source.kind === "each",
        guaranteed: isGuaranteed(graph, source, mergeId, name),
      });
    }
  }
  return fields;
}
