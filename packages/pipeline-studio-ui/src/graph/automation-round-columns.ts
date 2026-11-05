// Back edges and columns of an automation round: which edges point back up
// the flow, and how far right each node sits once they are set aside.
import type { RoundEdge, RoundNode } from "./automation-round-types";

/**
 * Edges that point back up the flow, found depth-first from the junctions
 * first (the automation's entry points), then every other node in document
 * order.
 */
export function findBackEdges(
  nodes: readonly RoundNode[],
  edges: readonly RoundEdge[],
): Set<string> {
  const outgoing = new Map<string, RoundEdge[]>();
  for (const edge of edges) {
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge]);
  }
  const back = new Set<string>();
  const state = new Map<string, "active" | "done">();
  const visit = (id: string): void => {
    state.set(id, "active");
    for (const edge of outgoing.get(id) ?? []) {
      const target = state.get(edge.target);
      if (target === "active") back.add(edge.id);
      else if (target === undefined) visit(edge.target);
    }
    state.set(id, "done");
  };
  const junctions = nodes.filter((node) => node.kind === "junction");
  for (const node of [...junctions, ...nodes]) {
    if (!state.has(node.id)) visit(node.id);
  }
  return back;
}

/**
 * Each node's column: the longest path to it from a node with no forward
 * predecessor, over the edges that aren't back edges.
 */
export function roundColumns(
  nodes: readonly RoundNode[],
  forward: readonly RoundEdge[],
): Map<string, number> {
  const column = new Map<string, number>();
  const columnOf = (id: string, seen: Set<string>): number => {
    const known = column.get(id);
    if (known !== undefined) return known;
    if (seen.has(id)) return 0;
    seen.add(id);
    const preds = forward.filter((edge) => edge.target === id);
    const value =
      preds.length === 0
        ? 0
        : Math.max(...preds.map((edge) => columnOf(edge.source, seen) + 1));
    column.set(id, value);
    return value;
  };
  for (const node of nodes) columnOf(node.id, new Set());
  return column;
}
