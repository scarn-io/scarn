/**
 * Pure edge-path geometry shared by the studio's and the Next app's edge
 * renderers. `translateDocumentToGraph` stamps a `StudioEdgeRoute` onto every
 * edge; a renderer turns it into an SVG path between the edge's real handle
 * coordinates (which React Flow measures) with the helpers here.
 *
 * Forward edges run through the waypoints dagre computed (label slots and
 * long-edge bends), drawn as axis-aligned segments with rounded corners —
 * siblings leaving one node share a trunk, then each drops through its own
 * label. Loop edges (back edges and self loops) leave the source's right
 * side, run up a dedicated lane to the right of everything they pass, and
 * enter the target's right side, so they never cross a node.
 */
import type {
  StudioEdgeRoute,
  StudioNodeKind,
  StudioPoint,
} from "./studio-graph-types";
import { nodeLayoutSize, orderedEdgeLabel } from "./studio-graph-visuals";

/** Handle ids of the bottom/top handles forward edges leave from and arrive at. */
export const FLOW_SOURCE_HANDLE = "out";
export const FLOW_TARGET_HANDLE = "in";
/** Handle ids of the right-side handles loop edges leave from and arrive at. */
export const LOOP_SOURCE_HANDLE = "loop-out";
export const LOOP_TARGET_HANDLE = "loop-in";

/** Horizontal offsets smaller than this are drawn straight rather than as a tiny jog. */
const STRAIGHT_TOLERANCE = 4;
const LABEL_CHAR_WIDTH = 6.8;
const LABEL_PADDING_X = 18;
export const EDGE_LABEL_HEIGHT = 22;

/** Approximate rendered width of an edge label pill (11px monospace). */
export function edgeLabelWidth(text: string): number {
  return Math.ceil(text.length * LABEL_CHAR_WIDTH + LABEL_PADDING_X);
}

function distance(a: StudioPoint, b: StudioPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function isCollinear(a: StudioPoint, b: StudioPoint, c: StudioPoint): boolean {
  return (
    (Math.abs(a.x - b.x) < 0.5 && Math.abs(b.x - c.x) < 0.5) ||
    (Math.abs(a.y - b.y) < 0.5 && Math.abs(b.y - c.y) < 0.5)
  );
}

function simplify(points: readonly StudioPoint[]): StudioPoint[] {
  const deduped: StudioPoint[] = [];
  for (const point of points) {
    const last = deduped.at(-1);
    if (!last || distance(last, point) > 0.5) deduped.push(point);
  }
  const result: StudioPoint[] = [];
  for (const point of deduped) {
    while (result.length >= 2) {
      const a = result[result.length - 2] as StudioPoint;
      const b = result[result.length - 1] as StudioPoint;
      if (!isCollinear(a, b, point)) break;
      result.pop();
    }
    result.push(point);
  }
  return result;
}

/**
 * The corner points of an axis-aligned polyline from `source` through each
 * waypoint to `target`. Between two points at different x it steps down to
 * their vertical midpoint, across, then down again.
 */
export function flowEdgeCorners(
  source: StudioPoint,
  waypoints: readonly StudioPoint[],
  target: StudioPoint,
): StudioPoint[] {
  const stops = [source, ...waypoints, target];
  const corners: StudioPoint[] = [source];
  for (let index = 1; index < stops.length; index += 1) {
    const from = stops[index - 1] as StudioPoint;
    const to = stops[index] as StudioPoint;
    if (Math.abs(from.x - to.x) < STRAIGHT_TOLERANCE) {
      corners.push(to);
      continue;
    }
    const midY = (from.y + to.y) / 2;
    corners.push({ x: from.x, y: midY }, { x: to.x, y: midY }, to);
  }
  return simplify(corners);
}

/** The corner points of a loop edge running up (or down) the lane at `laneX`. */
export function loopEdgeCorners(
  source: StudioPoint,
  laneX: number,
  target: StudioPoint,
): StudioPoint[] {
  return simplify([
    source,
    { x: laneX, y: source.y },
    { x: laneX, y: target.y },
    target,
  ]);
}

/** An SVG path through `corners` with each corner rounded by up to `radius`. */
export function roundedPath(
  corners: readonly StudioPoint[],
  radius = 10,
): string {
  const points = simplify(corners);
  const first = points[0];
  if (!first) return "";
  let path = `M ${String(first.x)} ${String(first.y)}`;
  for (let index = 1; index < points.length - 1; index += 1) {
    const prev = points[index - 1] as StudioPoint;
    const corner = points[index] as StudioPoint;
    const next = points[index + 1] as StudioPoint;
    const r = Math.min(
      radius,
      distance(prev, corner) / 2,
      distance(corner, next) / 2,
    );
    const enter = towards(corner, prev, r);
    const exit = towards(corner, next, r);
    path += ` L ${String(enter.x)} ${String(enter.y)} Q ${String(corner.x)} ${String(corner.y)} ${String(exit.x)} ${String(exit.y)}`;
  }
  const last = points.at(-1) as StudioPoint;
  if (points.length > 1) path += ` L ${String(last.x)} ${String(last.y)}`;
  return path;
}

function towards(
  from: StudioPoint,
  to: StudioPoint,
  length: number,
): StudioPoint {
  const total = distance(from, to);
  if (total === 0) return from;
  return {
    x: from.x + ((to.x - from.x) / total) * length,
    y: from.y + ((to.y - from.y) / total) * length,
  };
}

/**
 * The box the whole laid-out graph covers: every node plus the loop lanes
 * and edge labels that can stick out past them. Fitting the viewport to this
 * (rather than to the nodes alone) keeps loops and labels on screen.
 */
export function graphBounds(
  nodes: readonly {
    position: StudioPoint;
    data: { kind: StudioNodeKind; match?: "first" | "all"; mergeWaitsFor?: string[] };
  }[],
  edges: readonly {
    label?: unknown;
    data?: { route?: StudioEdgeRoute; order?: number | null };
  }[],
): { x: number; y: number; width: number; height: number } | null {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  const include = (x0: number, y0: number, x1: number, y1: number) => {
    left = Math.min(left, x0);
    top = Math.min(top, y0);
    right = Math.max(right, x1);
    bottom = Math.max(bottom, y1);
  };
  for (const node of nodes) {
    const { width, height } = nodeLayoutSize(node.data);
    include(node.position.x, node.position.y, node.position.x + width, node.position.y + height);
  }
  for (const edge of edges) {
    const route = edge.data?.route;
    if (!route) continue;
    const text = orderedEdgeLabel(
      typeof edge.label === "string" ? edge.label : undefined,
      edge.data?.order ?? null,
    );
    const halfLabel = text ? edgeLabelWidth(text) / 2 : 0;
    if (route.kind === "loop") {
      include(route.laneX - halfLabel, top, route.laneX + halfLabel, top);
    } else if (route.label) {
      include(
        route.label.x - halfLabel,
        route.label.y - EDGE_LABEL_HEIGHT / 2,
        route.label.x + halfLabel,
        route.label.y + EDGE_LABEL_HEIGHT / 2,
      );
    }
  }
  if (!Number.isFinite(left)) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * The SVG path and label anchor for an edge between the measured handle
 * coordinates `source` and `target`. Edges without a route (never laid out)
 * fall back to a plain stepped path with the label at its midpoint.
 */
export function routeEdge(
  route: StudioEdgeRoute | undefined,
  source: StudioPoint,
  target: StudioPoint,
): { path: string; labelX: number; labelY: number } {
  if (route?.kind === "loop") {
    return {
      path: roundedPath(loopEdgeCorners(source, route.laneX, target)),
      labelX: route.laneX,
      labelY: (source.y + target.y) / 2,
    };
  }
  const waypoints = route?.waypoints ?? [];
  return {
    path: roundedPath(flowEdgeCorners(source, waypoints, target)),
    labelX: route?.label?.x ?? (source.x + target.x) / 2,
    labelY: route?.label?.y ?? (source.y + target.y) / 2,
  };
}
