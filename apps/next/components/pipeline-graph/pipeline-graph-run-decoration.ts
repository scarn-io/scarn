import type {
  DecorateEdge,
  DecorateNode,
  EdgeDecoration,
  GraphIconName,
  NodeBadge,
  NodeDecoration,
} from "@scarn/pipeline-studio-ui/view";
import type { StudioEdge } from "@scarn/pipeline-studio-ui";
import { colors } from "@scarn/design-tokens";
import type {
  NodeVisualStatus,
  NodeVisualStatusColorKey,
} from "./pipeline-graph-node-status";

const STATUS_COLOR: Record<NodeVisualStatusColorKey, string> = {
  disabled: colors.textDim,
  primary: colors.accent,
  warning: colors.attentionFg,
  error: colors.dangerFg,
  success: colors.successFg,
};

const STATUS_ICON: Record<
  Exclude<NodeVisualStatusColorKey, "primary">,
  GraphIconName
> = {
  disabled: "statusDisabled",
  warning: "statusWarning",
  error: "statusError",
  success: "statusSucceeded",
};

function statusBadge(status: NodeVisualStatus): NodeBadge | null {
  const { colorKey } = status;
  if (!colorKey) return null;
  const label = status.label ? `Status: ${status.label}` : undefined;
  if (colorKey === "primary") return { kind: "spinner", label };
  return {
    kind: "icon",
    icon: STATUS_ICON[colorKey],
    color: STATUS_COLOR[colorKey],
    label,
  };
}

/**
 * A node's run status as the shared graph's decoration: a status-colored
 * border (none for not-yet-run/cancelled nodes), a spinner or status icon
 * badge, and the "N/M succeeded" lane count in the caption and tooltip.
 */
export function nodeDecorationForStatus(
  status: NodeVisualStatus,
): NodeDecoration {
  const { colorKey } = status;
  return {
    borderColor:
      colorKey && colorKey !== "disabled" ? STATUS_COLOR[colorKey] : null,
    badge: statusBadge(status),
    captionPrefix: status.badgeLabel,
    tooltip: status.badgeLabel,
    minimapColor: colorKey ? STATUS_COLOR[colorKey] : null,
  };
}

const TRAVERSED: EdgeDecoration = {
  strokeColor: colors.accent,
  emphasized: true,
  labelColor: colors.text,
};
const NOT_TRAVERSED: EdgeDecoration = {};

/** How a person's overrule left a route: turned on (with their reason) or turned off. */
export type EdgeOverruleMark =
  { kind: "overruled"; reason: string } | { kind: "superseded" };

/** The key `overruleEdgeOverlay` looks an edge's mark up by. */
export const edgeMarkKey = (nodeId: string, kind: string, index: number) =>
  `${nodeId}:${kind}:${String(index)}`;

/**
 * Layers overrule marks over an edge's run decoration: an overruled route is
 * drawn emphasized in the attention color with a person icon and the
 * reason in its tooltip; a superseded one is dimmed and dashed.
 */
export function overruleEdgeOverlay(
  marks: ReadonlyMap<string, EdgeOverruleMark>,
): (edge: StudioEdge, base: EdgeDecoration) => EdgeDecoration {
  return (edge, base) => {
    if (!edge.data) return base;
    const mark = marks.get(
      edgeMarkKey(edge.source, edge.data.kind, edge.data.index),
    );
    if (!mark) return base;
    if (mark.kind === "superseded") {
      return {
        strokeColor: colors.textDim,
        labelColor: colors.textDim,
        dashArray: "4 4",
        tooltip: "Turned off by a person's overrule",
      };
    }
    return {
      strokeColor: colors.attentionFg,
      emphasized: true,
      labelColor: colors.attentionFg,
      person: true,
      tooltip: `Overruled by a person: ${mark.reason}`,
    };
  };
}

/**
 * Decorators for the shared `PipelineGraphView` from a per-node status
 * lookup. An edge counts as traversed when a current visit reached its
 * *target* node, and is then drawn in the accent color.
 */
export function runDecorators(
  getNodeStatus: (nodeId: string) => NodeVisualStatus,
): {
  decorateNode: DecorateNode;
  decorateEdge: DecorateEdge;
} {
  const cache = new Map<string, NodeVisualStatus>();
  const statusOf = (nodeId: string) => {
    let status = cache.get(nodeId);
    if (!status) {
      status = getNodeStatus(nodeId);
      cache.set(nodeId, status);
    }
    return status;
  };
  return {
    decorateNode: (node) => nodeDecorationForStatus(statusOf(node.id)),
    decorateEdge: (edge) =>
      statusOf(edge.target).traversed ? TRAVERSED : NOT_TRAVERSED,
  };
}
