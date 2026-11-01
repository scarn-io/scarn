// Pure, React-free presentation logic shared by `GraphNode.tsx`,
// `GraphEdge.tsx` and `graph-decoration.ts` — kept in a plain `.ts` file (rather than inside
// either component) so `bun:test` can import and exercise it directly,
// without a JSX/React-DOM test environment.
import type {
  StudioEdgeData,
  StudioIssue,
  StudioNodeData,
  StudioNodeShape,
} from "./studio-graph-types";

/**
 * The highest-severity issue among `issues`, or `null` when there are none —
 * `"error"` wins over `"warning"` wins over `"info"`, regardless of
 * order/count.
 */
export function highestSeverity(
  issues: readonly Pick<StudioIssue, "severity">[],
): "error" | "warning" | "info" | null {
  let sawWarning = false;
  let sawInfo = false;
  for (const issue of issues) {
    if (issue.severity === "error") return "error";
    if (issue.severity === "warning") sawWarning = true;
    else sawInfo = true;
  }
  if (sawWarning) return "warning";
  return sawInfo ? "info" : null;
}

/**
 * The color for a given severity (or `null`, meaning "no issues"), as a
 * `--studio-severity-*` CSS variable reference. The actual values live in
 * `index-html-template.ts`'s per-theme palettes.
 */
export function severityColor(
  severity: "error" | "warning" | "info" | null,
): string {
  return `var(--studio-severity-${severity ?? "none"})`;
}

/**
 * "N in · M out" counts for a node's `shape` (input schema fields and result
 * schema fields) — `null` when the node has no step-derived shape, since
 * "0 in · 0 out" would falsely read as a step that declares zero fields.
 */
export function nodeInOutCounts(
  shape: StudioNodeShape,
): { inCount: number; outCount: number } | null {
  if (shape.kind === "none") return null;
  return {
    inCount: shape.inputFields.length,
    outCount: shape.resultFields.length,
  };
}

/** Formats `nodeInOutCounts`'s result as the literal "N in · M out" string. */
export function formatInOutCounts(counts: {
  inCount: number;
  outCount: number;
}): string {
  return `${String(counts.inCount)} in · ${String(counts.outCount)} out`;
}

const KIND_CAPTION: Record<StudioNodeData["kind"], string> = {
  start: "start",
  step: "step",
  wait: "wait",
  succeed: "succeed",
  fail: "fail",
  handoff: "hand-off",
};

/** The subtitle under a node's label, e.g. `step · triage` or `wait · decision`. */
export function nodeCaption(data: StudioNodeData): string {
  const detail = data.stepKey ?? data.waitFor;
  return detail
    ? `${KIND_CAPTION[data.kind]} · ${detail}`
    : KIND_CAPTION[data.kind];
}

/** The title-cased kind line on a graph node, e.g. `Step · triage` or `Decision`. */
export function kindLabel(
  data: Pick<StudioNodeData, "kind" | "stepKey" | "waitFor">,
): string {
  switch (data.kind) {
    case "start":
      return "Start";
    case "step":
      return data.stepKey ? `Step · ${data.stepKey}` : "Step";
    case "wait":
      if (data.waitFor === "decision") return "Decision";
      return data.waitFor ? `Wait · ${data.waitFor}` : "Wait";
    case "succeed":
      return "Succeed";
    case "fail":
      return "Fail";
    case "handoff":
      return data.stepKey ? `Hand-off · ${data.stepKey}` : "Hand-off";
  }
}

/** Which family of transition an edge draws as: plain flow, an error catch, or a loop back. */
export type EdgeTone = "flow" | "catch" | "loop";

export function edgeTone(
  data: Partial<Pick<StudioEdgeData, "kind" | "route">> | undefined,
): EdgeTone {
  if (data?.kind === "catch") return "catch";
  if (data?.route?.kind === "loop") return "loop";
  return "flow";
}

export type EdgeLegendKind = "flow" | "loop" | "catch" | "each" | "handoff";

export const EDGE_LEGEND_LABEL: Record<EdgeLegendKind, string> = {
  flow: "Next",
  loop: "Loop back",
  catch: "On error",
  each: "Each item",
  handoff: "Hand-off",
};

/**
 * The edge styles a graph's legend lists — always "flow", plus each other
 * style the graph actually contains.
 */
export function edgeLegendKinds(
  edges: readonly { data?: Partial<Pick<StudioEdgeData, "kind" | "lane" | "route">> }[],
): EdgeLegendKind[] {
  const kinds: EdgeLegendKind[] = ["flow"];
  if (edges.some((edge) => edge.data?.route?.kind === "loop")) kinds.push("loop");
  if (edges.some((edge) => edge.data?.kind === "catch")) kinds.push("catch");
  if (edges.some((edge) => edge.data?.lane === "each")) kinds.push("each");
  if (edges.some((edge) => edge.data?.kind === "handoff")) kinds.push("handoff");
  return kinds;
}

/**
 * The fork marker on a `match: "all"` node, whose matching routes all run
 * at once as lanes; `null` for every other node.
 */
export function forkMarker(data: Pick<StudioNodeData, "match">): string | null {
  return data.match === "all" ? "fork · all routes" : null;
}

/** The badge on a merge node listing the routes it waits for, e.g. `merges: Review, Test`. */
export function mergeBadge(
  data: Pick<StudioNodeData, "mergeWaitsFor">,
): string | null {
  const waitsFor = data.mergeWaitsFor ?? [];
  return waitsFor.length > 0 ? `merges: ${waitsFor.join(", ")}` : null;
}

/**
 * The pause tag on a step node whose agent can yield and resume, e.g.
 * `pauses · up to 10 rounds`; `null` when the document leaves `maxTurns` at
 * its default or turns pausing off with 0.
 */
export function pauseMarker(
  data: Pick<StudioNodeData, "kind" | "maxTurns">,
): string | null {
  if (data.kind !== "step" || !data.maxTurns) return null;
  const rounds = data.maxTurns === 1 ? "round" : "rounds";
  return `pauses · up to ${String(data.maxTurns)} ${rounds}`;
}

/**
 * An edge's label with its route order number in front (`1. x > 3`), for
 * `first` nodes that check their routes in order. Unordered edges keep their
 * label as is.
 */
export function orderedEdgeLabel(
  label: string | undefined,
  order: number | null,
): string | undefined {
  if (order === null) return label;
  return label === undefined
    ? `${String(order)}.`
    : `${String(order)}. ${label}`;
}

/** The dash pattern of hand-off edges and of a hand-off node's border. */
export const HANDOFF_DASH_ARRAY = "8 5";

/** React Flow node/edge type names `PipelineGraphView` registers. */
export const PIPELINE_NODE_TYPE = "pipelineNode";
export const HANDOFF_NODE_TYPE = "handoffNode";

const START_SIZE = { width: 112, height: 36 };
const TERMINAL_SIZE = { width: 176, height: 44 };
const CARD_WIDTH = 240;
const CARD_BASE_HEIGHT = 56;
const CARD_EXTRA_LINE_HEIGHT = 16;
const HANDOFF_SIZE = { width: CARD_WIDTH, height: 72 };

/**
 * The size the layout reserves for a node, which the node renderers also
 * draw at so edges meet the card exactly: a compact pill for the synthetic
 * start node, a smaller card for `succeed`/`fail`, and a step/wait card one
 * line taller for each fork marker, merge badge or pause marker it shows.
 */
export function nodeLayoutSize(
  data: Pick<StudioNodeData, "kind" | "match" | "mergeWaitsFor" | "maxTurns">,
): { width: number; height: number } {
  if (data.kind === "start") return { ...START_SIZE };
  if (data.kind === "handoff") return { ...HANDOFF_SIZE };
  if (data.kind === "succeed" || data.kind === "fail") {
    return { ...TERMINAL_SIZE };
  }
  const extraLines =
    (forkMarker(data) ? 1 : 0) +
    (mergeBadge(data) ? 1 : 0) +
    (pauseMarker(data) ? 1 : 0);
  return {
    width: CARD_WIDTH,
    height: CARD_BASE_HEIGHT + extraLines * CARD_EXTRA_LINE_HEIGHT,
  };
}

/**
 * Edge stroke dash pattern: catch edges are dashed so error paths read
 * differently from normal flow; `each` (fan-out into lanes) edges are dotted;
 * hand-off links are long-dashed, since no transition runs along them.
 */
export function edgeDashArray(
  data: Partial<Pick<StudioEdgeData, "kind" | "lane">> | undefined,
): string | undefined {
  if (data?.kind === "catch") return "6 4";
  if (data?.lane === "each") return "2 4";
  if (data?.kind === "handoff") return HANDOFF_DASH_ARRAY;
  return undefined;
}
