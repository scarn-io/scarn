// Pure pipeline document → React Flow `{nodes, edges}` translation. No I/O,
// no randomness: the same document + issues always produce the same graph,
// which is what lets this run identically in the browser, in the Next app
// (over a version's `definition_json`) and in the worker's studio server.
//
// `@xyflow/react`'s `Node`/`Edge` are imported type-only in
// `studio-graph-types.ts`, so importing THIS module never pulls in React or
// the React Flow runtime — only `dagre` (a plain graph-layout library with no
// DOM dependency, used by `graph-layout.ts`) is a real runtime dependency here.
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
import { layoutGraph } from "./graph-layout";
import type {
  PipelineGraphSnapshot,
  StudioEdge,
  StudioIssue,
  StudioNode,
  StudioNodeShape,
  StudioSchemaField,
} from "./studio-graph-types";

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
        maxTurns: node.kind === "step" ? node.maxTurns : undefined,
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
export {
  buildAutomationRound,
  routeMatchedLabel,
} from "./automation-round-model";
export {
  LANE_ORDER,
  LANE_TITLE,
  ROUND_CHANNEL_GAP,
  ROUND_COLUMN_WIDTH,
  ROUND_HANDLES,
  ROUND_ROW_HEIGHT,
  laneOf,
  layoutAutomationRound,
  roundNodeSize,
  type AutomationRoundLayout,
  type RoundEdgeData,
  type RoundEdgeTone,
  type RoundLane,
  type RoundLaneData,
  type RoundLayoutEdge,
  type RoundLayoutNode,
  type RoundLayoutNodeData,
  type RoundMemberData,
} from "./automation-round-layout";
export { findBackEdges } from "./automation-round-columns";
export {
  END_NODE_ID,
  attachNodeId,
  junctionNodeId,
  personNodeId,
  pipelineNodeId,
  stepNodeId,
  type AutomationRoundModel,
  type RoundAttachNode,
  type RoundEdge,
  type RoundEdgeKind,
  type RoundEndNode,
  type RoundJunctionNode,
  type RoundNode,
  type RoundNodeKind,
  type RoundPersonNode,
  type RoundPipelineNode,
  type RoundRouteEdge,
  type RoundSoftEdge,
  type RoundStepNode,
  type SoftLinkProvenance,
} from "./automation-round-types";
export {
  AutomationGraphError,
  type AutomationGraphInput,
} from "./automation-document-parse";

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
