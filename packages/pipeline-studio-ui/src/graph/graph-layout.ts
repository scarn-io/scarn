// Pure graph layout shared by the pipeline and automation translators: dagre
// for the forward flow, plus loop lanes for back edges. No React, no I/O.
import dagre from "dagre";
import {
  EDGE_LABEL_HEIGHT,
  edgeLabelWidth,
  FLOW_SOURCE_HANDLE,
  FLOW_TARGET_HANDLE,
  LOOP_SOURCE_HANDLE,
  LOOP_TARGET_HANDLE,
} from "./edge-route";
import type {
  StudioEdge,
  StudioEdgeRoute,
  StudioNode,
  StudioPoint,
} from "./studio-graph-types";
import { nodeLayoutSize, orderedEdgeLabel } from "./studio-graph-visuals";

const LOOP_LANE_GAP = 36;

/**
 * The ids of the edges that point back up the flow: a self loop, or an edge
 * to a node still on the depth-first path from the start node (visiting
 * routes in document order). Removing them leaves a DAG that reads top to
 * bottom; they are drawn as loops instead.
 */
function findBackEdges(nodes: StudioNode[], edges: StudioEdge[]): Set<string> {
  const outgoing = new Map<string, StudioEdge[]>();
  for (const edge of edges) {
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge]);
  }
  const back = new Set<string>();
  const state = new Map<string, "active" | "done">();
  const visit = (id: string): void => {
    state.set(id, "active");
    for (const edge of outgoing.get(id) ?? []) {
      const targetState = state.get(edge.target);
      if (targetState === "active") back.add(edge.id);
      else if (targetState === undefined) visit(edge.target);
    }
    state.set(id, "done");
  };
  for (const node of nodes) {
    if (!state.has(node.id)) visit(node.id);
  }
  return back;
}

type Box = { left: number; right: number; top: number; bottom: number };

function boxAround(center: StudioPoint, width: number, height: number): Box {
  return {
    left: center.x - width / 2,
    right: center.x + width / 2,
    top: center.y - height / 2,
    bottom: center.y + height / 2,
  };
}

/**
 * Picks a vertical lane for each loop edge, to the right of every node and
 * label box between its two ends and of every loop lane already placed over
 * an overlapping stretch. Shorter loops are placed first so they nest inside
 * longer ones instead of crossing them.
 */
function placeLoopLanes(
  loops: readonly {
    id: string;
    top: number;
    bottom: number;
    labelWidth: number;
  }[],
  obstacles: readonly Box[],
): Map<string, number> {
  const placed: { top: number; bottom: number; right: number }[] = [];
  const lanes = new Map<string, number>();
  const sorted = [...loops].sort(
    (a, b) => a.bottom - a.top - (b.bottom - b.top),
  );
  for (const loop of sorted) {
    const overlaps = (box: { top: number; bottom: number }) =>
      box.bottom > loop.top && box.top < loop.bottom;
    const clearOf = Math.max(
      ...obstacles.filter(overlaps).map((box) => box.right),
      ...placed.filter(overlaps).map((lane) => lane.right),
    );
    const halfLabel = Math.max(loop.labelWidth / 2, 0);
    const laneX = clearOf + LOOP_LANE_GAP + halfLabel;
    lanes.set(loop.id, laneX);
    placed.push({
      top: loop.top,
      bottom: loop.bottom,
      right: laneX + halfLabel,
    });
  }
  return lanes;
}

/**
 * Runs dagre over the graph minus its back edges, giving every forward edge
 * label a slot of its own so labels never overlap each other or a node, then
 * routes each back edge as a loop up a lane clear of everything it passes.
 * Writes node positions and each edge's `route` back in.
 */
export function layoutGraph(
  nodes: StudioNode[],
  edges: StudioEdge[],
): { nodes: StudioNode[]; edges: StudioEdge[] } {
  const backEdges = findBackEdges(nodes, edges);
  const graph = new dagre.graphlib.Graph({ multigraph: true });
  graph.setGraph({ rankdir: "TB", nodesep: 40, edgesep: 24, ranksep: 64 });
  graph.setDefaultEdgeLabel(() => ({}));

  const sizes = new Map(
    nodes.map((node) => [node.id, nodeLayoutSize(node.data)]),
  );
  for (const node of nodes) {
    graph.setNode(node.id, {
      ...(sizes.get(node.id) ?? { width: 0, height: 0 }),
    });
  }
  const labelText = (edge: StudioEdge) =>
    orderedEdgeLabel(
      typeof edge.label === "string" ? edge.label : undefined,
      edge.data?.order ?? null,
    );
  for (const edge of edges) {
    if (backEdges.has(edge.id)) continue;
    const text = labelText(edge);
    graph.setEdge(
      edge.source,
      edge.target,
      text
        ? {
            width: edgeLabelWidth(text),
            height: EDGE_LABEL_HEIGHT,
            labelpos: "c",
          }
        : { width: 0, height: 0 },
      edge.id,
    );
  }

  dagre.layout(graph);

  const centers = new Map<string, StudioPoint>();
  for (const node of nodes) {
    const laidOut = graph.node(node.id) as StudioPoint | undefined;
    if (laidOut) centers.set(node.id, { x: laidOut.x, y: laidOut.y });
  }

  const obstacles: Box[] = [];
  for (const node of nodes) {
    const center = centers.get(node.id);
    const size = sizes.get(node.id);
    if (center && size)
      obstacles.push(boxAround(center, size.width, size.height));
  }

  const flowRoutes = new Map<string, StudioEdgeRoute>();
  for (const edge of edges) {
    if (backEdges.has(edge.id)) continue;
    const laidOut = graph.edge(edge.source, edge.target, edge.id) as
      | { points?: StudioPoint[]; x?: number; y?: number; width: number }
      | undefined;
    if (!laidOut) continue;
    const label =
      laidOut.width > 0 && laidOut.x !== undefined && laidOut.y !== undefined
        ? { x: laidOut.x, y: laidOut.y }
        : null;
    if (label)
      obstacles.push(boxAround(label, laidOut.width, EDGE_LABEL_HEIGHT));
    flowRoutes.set(edge.id, {
      kind: "flow",
      waypoints: (laidOut.points ?? [])
        .slice(1, -1)
        .map(({ x, y }) => ({ x, y })),
      label,
    });
  }

  const loops = edges.flatMap((edge) => {
    if (!backEdges.has(edge.id)) return [];
    const source = centers.get(edge.source);
    const target = centers.get(edge.target);
    if (!source || !target) return [];
    const text = labelText(edge);
    const halfHeight = (id: string) => (sizes.get(id)?.height ?? 0) / 2;
    return [
      {
        id: edge.id,
        top: Math.min(
          target.y - halfHeight(edge.target),
          source.y - halfHeight(edge.source),
        ),
        bottom: Math.max(
          source.y + halfHeight(edge.source),
          target.y + halfHeight(edge.target),
        ),
        labelWidth: text ? edgeLabelWidth(text) : 0,
      },
    ];
  });
  const lanes = placeLoopLanes(loops, obstacles);

  return {
    nodes: nodes.map((node) => {
      const center = centers.get(node.id);
      const size = sizes.get(node.id);
      if (!center || !size) return node;
      return {
        ...node,
        position: {
          x: center.x - size.width / 2,
          y: center.y - size.height / 2,
        },
      };
    }),
    edges: edges.map((edge) => {
      const laneX = lanes.get(edge.id);
      const route: StudioEdgeRoute | undefined =
        laneX !== undefined ? { kind: "loop", laneX } : flowRoutes.get(edge.id);
      if (!route || !edge.data) return edge;
      const isLoop = route.kind === "loop";
      return {
        ...edge,
        sourceHandle: isLoop ? LOOP_SOURCE_HANDLE : FLOW_SOURCE_HANDLE,
        targetHandle: isLoop ? LOOP_TARGET_HANDLE : FLOW_TARGET_HANDLE,
        data: { ...edge.data, route },
      };
    }),
  };
}
