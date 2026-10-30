import type { GraphIconName } from "./graph-icons";
import { SEVERITY_COLOR, TONE_COLOR } from "./graph-palette";
import type { StudioEdge, StudioNode } from "./studio-graph-types";
import {
  edgeTone,
  formatInOutCounts,
  highestSeverity,
  nodeInOutCounts,
} from "./studio-graph-visuals";

/** The corner badge on a node: a spinner, a status icon, or a count. */
export type NodeBadge =
  | { kind: "spinner"; label?: string }
  | { kind: "icon"; icon: GraphIconName; color: string; label?: string }
  | { kind: "count"; count: number; color: string; label?: string };

/**
 * What a host app layers on top of a node's kind-based look: run status in
 * the web app, validation issues in the studio and docs.
 */
export type NodeDecoration = {
  /** Replaces the card's neutral border and kind-colored stripe. */
  borderColor: string | null;
  badge: NodeBadge | null;
  /** Shown before the kind label in a card's caption, e.g. `2/3 succeeded`. */
  captionPrefix?: string | null;
  /** Shown after the kind label in a card's caption, e.g. `2 in · 1 out`. */
  captionSuffix?: string | null;
  /** Appended to the node's tooltip. */
  tooltip?: string | null;
  /** Minimap fill; defaults to `borderColor`. */
  minimapColor?: string | null;
};

/** What a host app layers on top of an edge's tone-based look. */
export type EdgeDecoration = {
  /** Replaces the tone color for the stroke, arrowhead and label. */
  strokeColor?: string | null;
  /** Draws the edge thicker. */
  emphasized?: boolean;
  /** The label's text color; defaults to muted text for plain edges, else the stroke. */
  labelColor?: string | null;
};

export type DecorateNode = (node: StudioNode) => NodeDecoration;
export type DecorateEdge = (edge: StudioEdge) => EdgeDecoration;

export const EMPTY_NODE_DECORATION: NodeDecoration = {
  borderColor: null,
  badge: null,
};

export const EMPTY_EDGE_DECORATION: EdgeDecoration = {};

/** An edge's stroke color: its decoration's, else its tone's. */
export function edgeStroke(
  edge: Pick<StudioEdge, "data">,
  decoration: EdgeDecoration,
): string {
  return decoration.strokeColor ?? TONE_COLOR[edgeTone(edge.data)];
}

/**
 * The studio's decoration: a node's validation issues as a severity border
 * and count badge, and its step's "N in · M out" schema field counts.
 */
export function decorateNodeWithIssues(node: StudioNode): NodeDecoration {
  const { issues, shape } = node.data;
  const severity = highestSeverity(issues);
  const counts = nodeInOutCounts(shape);
  return {
    borderColor: severity ? SEVERITY_COLOR[severity] : null,
    badge: severity
      ? {
          kind: "count",
          count: issues.length,
          color: SEVERITY_COLOR[severity],
          label: `${String(issues.length)} validation issue(s)`,
        }
      : null,
    captionSuffix: counts ? formatInOutCounts(counts) : null,
  };
}

/** The studio's edge decoration: an edge with issues is drawn in its severity color. */
export function decorateEdgeWithIssues(edge: StudioEdge): EdgeDecoration {
  const severity = highestSeverity(edge.data?.issues ?? []);
  return severity
    ? { strokeColor: SEVERITY_COLOR[severity], emphasized: true }
    : EMPTY_EDGE_DECORATION;
}
