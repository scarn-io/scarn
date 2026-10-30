// Pure pipeline document → React Flow `{nodes, edges}` translation. No I/O,
// no randomness: the same document + issues always produce the same graph,
// which is what lets this run identically in the browser, in the Next app
// (over a version's `definition_json`) and in the worker's studio server.
//
// `@xyflow/react`'s `Node`/`Edge` are imported type-only in
// `studio-graph-types.ts`, so importing THIS module never pulls in React or
// the React Flow runtime — only `dagre` (a plain graph-layout library with no
// DOM dependency) is a real runtime dependency here.
import dagre from "dagre";
import {
  CONVERSATION_RESULT_SCHEMA,
  routeAt,
  type JsonSchema,
  type PipelineDocument,
  type PipelineNode,
  type StepCatalog,
} from "@scarn/sdk/contracts/pipeline-document";
import {
  buildGraph,
  type Edge as DocumentEdge,
} from "@scarn/shared-core/pipelines";
import { describeCatch, describeRoute } from "./describe-transition";
import {
  EDGE_LABEL_HEIGHT,
  edgeLabelWidth,
  FLOW_SOURCE_HANDLE,
  FLOW_TARGET_HANDLE,
  LOOP_SOURCE_HANDLE,
  LOOP_TARGET_HANDLE,
} from "./edge-route";
import type {
  PipelineGraphSnapshot,
  StudioEdge,
  StudioEdgeRoute,
  StudioIssue,
  StudioNode,
  StudioNodeShape,
  StudioPoint,
  StudioSchemaField,
} from "./studio-graph-types";
import { nodeLayoutSize, orderedEdgeLabel } from "./studio-graph-visuals";

const LOOP_LANE_GAP = 36;

/** Id of the synthetic node the document's `start` transition leaves from. */
export const START_NODE_ID = "$start";

function schemaType(schema: JsonSchema): string {
  if (typeof schema === "boolean") return "any";
  if (Array.isArray(schema.type)) return schema.type.join(" | ");
  if (typeof schema.type === "string") return schema.type;
  if (schema.$ref !== undefined) return schema.$ref.split("/").at(-1) ?? "ref";
  if (schema.anyOf ?? schema.oneOf) return "union";
  if (schema.enum !== undefined) return "enum";
  return "any";
}

/** The top-level properties of an object schema, in declaration order. */
export function schemaFields(schema: JsonSchema): StudioSchemaField[] {
  if (typeof schema === "boolean" || !schema.properties) return [];
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties).map(([name, property]) => ({
    name,
    type: schemaType(property),
    required: required.has(name),
  }));
}

function nodeShape(node: PipelineNode, steps: StepCatalog): StudioNodeShape {
  if (node.kind !== "step") return { kind: "none" };
  const step = steps[node.step];
  if (!step) return { kind: "none" };
  const resultSchema = step.resultSchema ?? CONVERSATION_RESULT_SCHEMA;
  return {
    kind: "step",
    inputFields: schemaFields(step.inputSchema),
    resultFields: schemaFields(resultSchema),
    resultSchemaJson: typeof resultSchema === "boolean" ? {} : resultSchema,
    errors: [...step.errors],
  };
}

function edgeId(edge: DocumentEdge): string {
  return `${edge.from ?? START_NODE_ID}:${edge.kind}:${String(edge.index)}->${edge.to}`;
}

function edgePointer(edge: DocumentEdge): string {
  return `/${edge.pointer.map(String).join("/")}`;
}

function edgeLabel(
  document: PipelineDocument,
  edge: DocumentEdge,
): string | undefined {
  if (edge.from === null) return describeRoute(document.start, "start");
  const node = document.nodes[edge.from];
  if (!node || (node.kind !== "step" && node.kind !== "wait")) return undefined;
  if (edge.kind === "catch") {
    const entry = node.kind === "step" ? node.catch?.[edge.index] : undefined;
    return entry ? describeCatch(entry) : "catch";
  }
  if (edge.kind === "start") return undefined;
  const route = routeAt(node.next, edge.kind, edge.index);
  return route
    ? describeRoute(route, edge.kind, node.next?.match ?? "first")
    : undefined;
}

function nodeMatch(node: PipelineNode): "first" | "all" | undefined {
  if (node.kind !== "step" && node.kind !== "wait") return undefined;
  return node.next ? (node.next.match ?? "first") : undefined;
}

/** The 1-based check order of a route of a `first` node with several routes. */
function routeOrder(
  document: PipelineDocument,
  edge: DocumentEdge,
): number | null {
  if (edge.kind !== "route" || edge.from === null) return null;
  const node = document.nodes[edge.from];
  if (node?.kind !== "step" && node?.kind !== "wait") return null;
  if (node.next === undefined || nodeMatch(node) !== "first") return null;
  return node.next.routes.length > 1 ? edge.index + 1 : null;
}

/** Each merge node's waited-for sources: the titles of the nodes its `partial` routes come from. */
function mergeSources(
  document: PipelineDocument,
  edges: readonly DocumentEdge[],
): Map<string, string[]> {
  const sources = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.lane !== "partial" || edge.from === null) continue;
    const title = document.nodes[edge.from]?.title ?? edge.from;
    const existing = sources.get(edge.to) ?? [];
    if (!existing.includes(title)) sources.set(edge.to, [...existing, title]);
  }
  return sources;
}

/** The node id a document pointer such as `/nodes/fix/next/routes/0` is about. */
export function nodeIdFromPath(path: string | undefined): string | undefined {
  const match = /^\/nodes\/([^/]+)/.exec(path ?? "");
  return match?.[1]?.replaceAll("~1", "/").replaceAll("~0", "~");
}

function isWithin(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function pushTo(
  map: Map<string, StudioIssue[]>,
  key: string,
  issue: StudioIssue,
): void {
  map.set(key, [...(map.get(key) ?? []), issue]);
}

/**
 * Attaches each issue for this pipeline to the edge whose transition its
 * `path` points into, else to the node it names. Issues with no path inside
 * a node or transition (document-level ones) attach nowhere and are shown in
 * the issues list only.
 */
function attachIssues(
  document: PipelineDocument,
  edges: readonly DocumentEdge[],
  issues: readonly StudioIssue[],
): { byNode: Map<string, StudioIssue[]>; byEdge: Map<string, StudioIssue[]> } {
  const byNode = new Map<string, StudioIssue[]>();
  const byEdge = new Map<string, StudioIssue[]>();
  for (const issue of issues) {
    if (issue.pipelineKey !== document.key || issue.path === undefined)
      continue;
    const path = issue.path;
    const edge = edges.find((candidate) =>
      isWithin(path, edgePointer(candidate)),
    );
    if (edge) {
      pushTo(byEdge, edgeId(edge), issue);
      continue;
    }
    const nodeId = nodeIdFromPath(path);
    if (nodeId !== undefined) pushTo(byNode, nodeId, issue);
  }
  return { byNode, byEdge };
}

function buildRawGraph(
  document: PipelineDocument,
  issues: readonly StudioIssue[],
  steps: StepCatalog,
): { nodes: StudioNode[]; edges: StudioEdge[] } {
  const graph = buildGraph(document);
  const { byNode, byEdge } = attachIssues(document, graph.edges, issues);
  const merges = mergeSources(document, graph.edges);

  const startNode: StudioNode = {
    id: START_NODE_ID,
    position: { x: 0, y: 0 },
    data: {
      label: "Start",
      kind: "start",
      issues: [],
      shape: { kind: "none" },
    },
  };
  const nodes: StudioNode[] = [
    startNode,
    ...Object.entries(document.nodes).map(([id, node]) => ({
      id,
      position: { x: 0, y: 0 },
      data: {
        label: node.title ?? id,
        kind: node.kind,
        stepKey: node.kind === "step" ? node.step : undefined,
        waitFor: node.kind === "wait" ? node.for : undefined,
        match: nodeMatch(node),
        mergeWaitsFor: merges.get(id),
        issues: byNode.get(id) ?? [],
        shape: nodeShape(node, steps),
      },
    })),
  ];

  const edges: StudioEdge[] = graph.edges.map((edge) => ({
    id: edgeId(edge),
    source: edge.from ?? START_NODE_ID,
    target: edge.to,
    label: edgeLabel(document, edge),
    data: {
      kind: edge.kind,
      index: edge.index,
      lane: edge.lane,
      order: routeOrder(document, edge),
      issues: byEdge.get(edgeId(edge)) ?? [],
    },
  }));

  return { nodes, edges };
}

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
  loops: readonly { id: string; top: number; bottom: number; labelWidth: number }[],
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
    placed.push({ top: loop.top, bottom: loop.bottom, right: laneX + halfLabel });
  }
  return lanes;
}

/**
 * Runs dagre over the graph minus its back edges, giving every forward edge
 * label a slot of its own so labels never overlap each other or a node, then
 * routes each back edge as a loop up a lane clear of everything it passes.
 * Writes node positions and each edge's `route` back in.
 */
function layoutGraph(
  nodes: StudioNode[],
  edges: StudioEdge[],
): { nodes: StudioNode[]; edges: StudioEdge[] } {
  const backEdges = findBackEdges(nodes, edges);
  const graph = new dagre.graphlib.Graph({ multigraph: true });
  graph.setGraph({ rankdir: "TB", nodesep: 40, edgesep: 24, ranksep: 64 });
  graph.setDefaultEdgeLabel(() => ({}));

  const sizes = new Map(nodes.map((node) => [node.id, nodeLayoutSize(node.data)]));
  for (const node of nodes) {
    graph.setNode(node.id, { ...(sizes.get(node.id) ?? { width: 0, height: 0 }) });
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
        ? { width: edgeLabelWidth(text), height: EDGE_LABEL_HEIGHT, labelpos: "c" }
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
    if (center && size) obstacles.push(boxAround(center, size.width, size.height));
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
    if (label) obstacles.push(boxAround(label, laidOut.width, EDGE_LABEL_HEIGHT));
    flowRoutes.set(edge.id, {
      kind: "flow",
      waypoints: (laidOut.points ?? []).slice(1, -1).map(({ x, y }) => ({ x, y })),
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
        top: Math.min(target.y - halfHeight(edge.target), source.y - halfHeight(edge.source)),
        bottom: Math.max(source.y + halfHeight(edge.source), target.y + halfHeight(edge.target)),
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
        position: { x: center.x - size.width / 2, y: center.y - size.height / 2 },
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

/**
 * Translates one pipeline document into a React Flow graph: a synthetic
 * start node, one node per document node, and one edge per `start`
 * transition, `next` route (`otherwise` included) and `catch` handler
 * (labelled with its condition, `always`, `otherwise`, `each`/`partial` lane
 * marker or caught error names). Step and wait nodes carry their `match`
 * mode, merge nodes the sources of their `partial` routes, and routes of a
 * `first` node with several routes their check order. Every issue is
 * attached to the edge or node its JSON pointer names. Positions are always
 * computed by `dagre`; every edge carries its `route` (see `layoutGraph`),
 * which a renderer draws with `routeEdge`.
 *
 * `steps` resolves each step node's input/result shape (see
 * `StudioNodeShape`). Pass `{}` when no step catalog is available; every
 * node's `shape` then falls back to `{kind: "none"}`.
 */
export function translateDocumentToGraph(
  document: PipelineDocument,
  issues: readonly StudioIssue[] = [],
  steps: StepCatalog = {},
): { nodes: StudioNode[]; edges: StudioEdge[] } {
  const { nodes, edges } = buildRawGraph(document, issues, steps);
  return layoutGraph(nodes, edges);
}

/** `translateDocumentToGraph`, wrapped with the pipeline's own key/title. */
export function translatePipelineToSnapshot(
  document: PipelineDocument,
  issues: readonly StudioIssue[] = [],
  steps: StepCatalog = {},
): PipelineGraphSnapshot {
  const { nodes, edges } = translateDocumentToGraph(document, issues, steps);
  return {
    key: document.key,
    name: document.title ?? document.key,
    nodes,
    edges,
  };
}

export { describeCondition } from "./describe-transition";

export type {
  BrokenPipeline,
  PipelineGraphSnapshot,
  StudioEdge,
  StudioEdgeData,
  StudioEdgeKind,
  StudioEdgeRoute,
  StudioPoint,
  StudioIssue,
  StudioNode,
  StudioNodeData,
  StudioNodeKind,
  StudioNodeShape,
  StudioSchemaField,
  StudioSnapshot,
} from "./studio-graph-types";
