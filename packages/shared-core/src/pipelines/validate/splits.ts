/**
 * Split analysis, shared by the validator and the engine: which nodes start
 * lanes (a `match: "all"` node, or a route with `each`), which nodes those
 * lanes visit (each node's scope, and the split routes its lanes can come
 * from), and the merges (`partial` routes) that bring them together.
 *
 * A merge closes the innermost split its partial routes come from when no
 * lane of the split can get past it without going through it. It also closes
 * the enclosing splits it closes (a cascading closing merge), unless the
 * merge itself later ends with a `partial` route, which means it still runs
 * inside the enclosing lane. A merge that doesn't close an `all` split is a
 * partial merge: its arriving lanes continue as one lane of the same split.
 */
import { jsonPointer } from "@scarn/sdk/contracts/pipeline-document";
import {
  isPrefix,
  reachableFrom,
  type Edge,
  type PipelineGraph,
} from "./graph";
import type { MergeField } from "./merge-fields";
import { buildMerges, type Closing, type Position } from "./split-merges";
import type { ValidationError } from "./types";

export type { MergeField } from "./merge-fields";

/** A `match: "all"` node or an `each` route: the lanes it starts. */
export interface Split {
  id: string;
  kind: "each" | "all";
  /** The node whose `next` starts the lanes. */
  node: string;
  /** The routes that start lanes, by route id: one for `each`, every route plus `otherwise` for `all`. */
  routes: Map<string, Edge>;
  /** The enclosing split, or null at the top level. */
  parent: string | null;
  /** The nodes its lanes (and nested lanes) visit before arriving at a merge. */
  region: Set<string>;
  /** The merge that closes it, if any route of its lanes reaches one. */
  merge: string | null;
}

export interface Merge {
  nodeId: string;
  /** The splits it closes, innermost first. */
  closes: string[];
  /** The `all` split it's a partial merge of: its lanes continue as one lane of that split. */
  partialOf: string | null;
  /** Its incoming `partial` routes. */
  incoming: Edge[];
  fields: Map<string, MergeField>;
}

export interface SplitAnalysis {
  splits: Map<string, Split>;
  merges: Map<string, Merge>;
  /** Each reachable node's enclosing splits, outermost first. */
  scopes: Map<string, readonly string[]>;
  /** The routes of its innermost split each node's lanes can come from (empty at the top level). */
  origins: Map<string, readonly string[]>;
  errors: ValidationError[];
  /** The nodes reachable from `nodeId` (not including itself unless it loops). */
  reachable(nodeId: string): ReadonlySet<string>;
}

/** The id of a route that starts lanes (and of the `each` split it starts): `<node>:<kind>:<index>`. */
export function splitIdOf(
  from: string,
  kind: "route" | "otherwise",
  index: number,
): string {
  return `${from}:${kind}:${String(index)}`;
}

/** The id of the split a `match: "all"` node starts. */
export function allSplitIdOf(nodeId: string): string {
  return `${nodeId}:all`;
}

export function routeIdOf(edge: Edge): string {
  return splitIdOf(
    edge.from ?? "",
    edge.kind === "otherwise" ? "otherwise" : "route",
    edge.index,
  );
}

function isTerminal(graph: PipelineGraph, nodeId: string): boolean {
  const kind = graph.nodes[nodeId]?.kind;
  return kind === "succeed" || kind === "fail";
}

function isAllRoute(graph: PipelineGraph, edge: Edge): boolean {
  const node = graph.nodes[edge.from ?? ""];
  return (
    (edge.kind === "route" || edge.kind === "otherwise") &&
    (node?.kind === "step" || node?.kind === "wait") &&
    node.next?.match === "all"
  );
}

/** No lane of the split reaches the merge's successors without going through the merge. */
function closesSplit(
  graph: PipelineGraph,
  split: Split,
  mergeId: string,
): boolean {
  const entries = [...split.routes.values()]
    .map((edge) => edge.to)
    .filter((to) => to !== mergeId);
  const around = reachableFrom(graph, entries, mergeId);
  for (const entry of entries) {
    around.add(entry);
  }
  return (graph.outgoing.get(mergeId) ?? []).every(
    (edge) => isTerminal(graph, edge.to) || !around.has(edge.to),
  );
}

/** Whether a path from `nodeId` ends its lane with a `partial` route before any merge of its own. */
function endsWithPartial(graph: PipelineGraph, nodeId: string): boolean {
  const limit = Object.keys(graph.nodes).length;
  const seen = new Set<string>();
  const queue: [string, number][] = [[nodeId, 0]];
  while (queue.length > 0) {
    const [current, depth] = queue.shift() as [string, number];
    for (const edge of graph.outgoing.get(current) ?? []) {
      if (edge.lane === "partial" && depth === 0) {
        return true;
      }
      const next =
        depth +
        (isAllRoute(graph, edge) ? 1 : 0) +
        (edge.lane === "each" ? 1 : edge.lane === "partial" ? -1 : 0);
      const key = `${edge.to}:${String(next)}`;
      if (next <= limit && !seen.has(key)) {
        seen.add(key);
        queue.push([edge.to, next]);
      }
    }
  }
  return false;
}

function describeSource(edge: Edge): string {
  return edge.from === null ? "the start" : `"${edge.from}"`;
}

function sameScope(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && isPrefix(left, right);
}

const ROOT: Position = { scope: [], origins: [] };

function sameSet(left: ReadonlySet<string>, right?: ReadonlySet<string>) {
  return (
    right !== undefined &&
    left.size === right.size &&
    [...left].every((id) => right.has(id))
  );
}

function contains(
  outer: Position["origins"],
  inner: Position["origins"],
): boolean {
  return inner.every((origin, index) =>
    [...origin].every((id) => outer[index]?.has(id) === true),
  );
}

export function analyzeSplits(graph: PipelineGraph): SplitAnalysis {
  const splits = new Map<string, Split>();
  const positions = new Map<string, Position>();
  const errors: ValidationError[] = [];
  const reported = new Set<string>();
  const closings = new Map<Edge, Closing | null>();
  const mergeNodes = new Set(
    graph.edges.filter((edge) => edge.lane === "partial").map((e) => e.to),
  );

  const report = (key: string, error: ValidationError) => {
    if (!reported.has(key)) {
      reported.add(key);
      errors.push(error);
    }
  };

  const splitFor = (
    id: string,
    kind: Split["kind"],
    node: string,
    parent: string | null,
  ): Split => {
    const existing = splits.get(id);
    if (existing !== undefined) {
      return existing;
    }
    const split: Split = {
      id,
      kind,
      node,
      routes: new Map(),
      parent,
      region: new Set(),
      merge: null,
    };
    splits.set(id, split);
    return split;
  };

  const closeAt = (edge: Edge, scope: readonly string[]): Closing | null => {
    const innermost = scope.at(-1);
    if (innermost === undefined) {
      report(`outside>${jsonPointer(edge.pointer)}`, {
        code: "split",
        path: jsonPointer([...edge.pointer, "partial"]),
        message: `A "partial" route must come from inside a split, but ${describeSource(edge)} doesn't run in lanes`,
        hint: 'Remove "partial", or start lanes earlier with "each" or "match": "all"',
      });
      return null;
    }
    const split = splits.get(innermost) as Split;
    if (!closesSplit(graph, split, edge.to)) {
      if (split.kind === "all") {
        return { closes: [], partialOf: split.id };
      }
      report(`${innermost}>${edge.to}`, {
        code: "split",
        path: jsonPointer([...edge.pointer, "to"]),
        message: `"${edge.to}" doesn't close the split started at "${split.node}": its lanes can reach what comes after "${edge.to}" without going through it`,
        hint: `Send every path of the lanes to "${edge.to}" with a "partial" route, or end them`,
      });
    }
    const closes = [innermost];
    let remaining = scope.length - 2;
    if (!endsWithPartial(graph, edge.to)) {
      for (; remaining >= 0; remaining -= 1) {
        const parent = splits.get(scope[remaining] as string) as Split;
        if (!closesSplit(graph, parent, edge.to)) {
          break;
        }
        closes.push(parent.id);
      }
    }
    const rest = remaining >= 0 ? splits.get(scope[remaining] as string) : null;
    return {
      closes,
      partialOf:
        rest?.kind === "all" && !closesSplit(graph, rest, edge.to)
          ? rest.id
          : null,
    };
  };

  const targetOf = (edge: Edge, position: Position): Position | null => {
    let { scope, origins } = position;
    if (isAllRoute(graph, edge)) {
      const id = allSplitIdOf(edge.from as string);
      const split = splitFor(
        id,
        "all",
        edge.from as string,
        scope.at(-1) ?? null,
      );
      split.routes.set(routeIdOf(edge), edge);
      scope = [...scope, id];
      origins = [...origins, new Set([routeIdOf(edge)])];
      if (edge.lane === "partial") {
        report(`all-partial>${jsonPointer(edge.pointer)}`, {
          code: "split",
          path: jsonPointer([...edge.pointer, "partial"]),
          message: `A route of a "match": "all" node starts a lane, so it can't also be "partial"`,
          hint: 'Route to a step first and make its route "partial", or use "match": "first"',
        });
        return null;
      }
    }
    if (edge.lane === "each" && edge.from !== null) {
      const id = routeIdOf(edge);
      splitFor(id, "each", edge.from, scope.at(-1) ?? null).routes.set(
        id,
        edge,
      );
      return { scope: [...scope, id], origins: [...origins, new Set([id])] };
    }
    if (edge.lane === "partial") {
      if (!closings.has(edge)) {
        closings.set(edge, closeAt(edge, scope));
      }
      const closing = closings.get(edge) ?? null;
      if (closing === null) {
        return null;
      }
      const depth = scope.length - closing.closes.length;
      return { scope: scope.slice(0, depth), origins: origins.slice(0, depth) };
    }
    return { scope, origins };
  };

  const arrive = (edge: Edge, target: Position): boolean => {
    const existing = positions.get(edge.to);
    if (existing === undefined) {
      positions.set(edge.to, target);
      return true;
    }
    if (!sameScope(existing.scope, target.scope)) {
      if (!isTerminal(graph, edge.to)) {
        report(`scope>${edge.to}`, {
          code: "split",
          path: jsonPointer([...edge.pointer, "to"]),
          message: `"${edge.to}" is reached ${describeScope(target.scope)} here but ${describeScope(existing.scope)} elsewhere; a node can't run both inside and outside a split's lanes`,
          hint: 'Add or remove "each", "match": "all" or "partial" so every path reaches it the same way, or use a separate node',
        });
      }
      return false;
    }
    if (contains(existing.origins, target.origins)) {
      return false;
    }
    positions.set(edge.to, {
      scope: existing.scope,
      origins: existing.origins.map(
        (origin, index) =>
          new Set([...origin, ...(target.origins[index] ?? [])]),
      ),
    });
    return true;
  };

  const queue: (string | null)[] = [null];
  while (queue.length > 0) {
    const current = queue.shift() as string | null;
    const position = current === null ? ROOT : (positions.get(current) ?? ROOT);
    for (const edge of graph.outgoing.get(current) ?? []) {
      const target = targetOf(edge, position);
      if (target !== null && arrive(edge, target)) {
        queue.push(edge.to);
      }
    }
  }

  for (const edge of graph.edges) {
    const existing = positions.get(edge.to);
    const from = edge.from === null ? ROOT : positions.get(edge.from);
    if (
      existing === undefined ||
      from === undefined ||
      mergeNodes.has(edge.to) ||
      isTerminal(graph, edge.to)
    ) {
      continue;
    }
    const target = targetOf(edge, from);
    if (target === null || !sameScope(existing.scope, target.scope)) {
      continue;
    }
    const level = existing.origins.findIndex(
      (origin, index) => !sameSet(origin, target.origins[index]),
    );
    if (level !== -1) {
      const split = splits.get(existing.scope[level] as string);
      report(`meet>${edge.to}`, {
        code: "split",
        path: jsonPointer([...edge.pointer, "to"]),
        message: `Lanes from different routes of "${split?.node ?? ""}" meet at "${edge.to}" without "partial"`,
        hint: `Make "${edge.to}" a merge by adding "partial": true to every route into it, or use a separate node`,
      });
    }
  }

  const scopes = new Map<string, readonly string[]>();
  const origins = new Map<string, readonly string[]>();
  for (const [nodeId, position] of positions) {
    scopes.set(nodeId, position.scope);
    origins.set(nodeId, [...(position.origins.at(-1) ?? [])].sort());
    for (const id of position.scope) {
      splits.get(id)?.region.add(nodeId);
    }
  }
  const merges = buildMerges(graph, splits, positions, closings, errors);
  const reachableCache = new Map<string, Set<string>>();
  return {
    splits,
    merges,
    scopes,
    origins,
    errors,
    reachable(nodeId) {
      const cached = reachableCache.get(nodeId);
      if (cached !== undefined) {
        return cached;
      }
      const found = reachableFrom(graph, [nodeId]);
      reachableCache.set(nodeId, found);
      return found;
    },
  };
}

function describeScope(scope: readonly string[]): string {
  return scope.length === 0
    ? "outside any split"
    : `inside ${String(scope.length)} level${scope.length === 1 ? "" : "s"} of lanes (${scope.map((id) => `"${id}"`).join(" > ")})`;
}
