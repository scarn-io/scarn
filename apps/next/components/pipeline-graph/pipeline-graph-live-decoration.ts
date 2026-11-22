import {
  EMPTY_NODE_DECORATION,
  type DecorateNode,
  type NodeBadge,
} from "@scarn/pipeline-studio-ui/view";
import { colors } from "@scarn/design-tokens";

/** One node's live counts, as the live-counts endpoint reports them. */
export type NodeLiveCount = {
  running: number;
  waiting: number;
  failed: number;
  lanes: number;
};

/** "2 running · 1 waiting · 1 failed · 3 lanes", leaving out zeros. */
export function formatNodeLiveCount(count: NodeLiveCount): string {
  return [
    count.running > 0 ? `${String(count.running)} running` : null,
    count.waiting > 0 ? `${String(count.waiting)} waiting` : null,
    count.failed > 0 ? `${String(count.failed)} failed` : null,
    count.lanes > 0
      ? `${String(count.lanes)} lane${count.lanes === 1 ? "" : "s"}`
      : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
}

function liveBadge(count: NodeLiveCount, summary: string): NodeBadge | null {
  const open = count.running + count.waiting;
  if (open > 0) {
    return {
      kind: "count",
      count: open,
      color: count.running > 0 ? colors.accent : colors.textDim,
      label: summary,
    };
  }
  if (count.failed > 0) {
    return {
      kind: "count",
      count: count.failed,
      color: colors.dangerFg,
      label: summary,
    };
  }
  return null;
}

/**
 * Decorates each node with where live runs are: a count badge of open
 * visits (accent while any run, grey when all wait), or of recent failures
 * in red, and the breakdown in the caption and tooltip. Nodes without
 * counts keep their plain look.
 */
export function liveCountDecorator(
  counts: Readonly<Record<string, NodeLiveCount>>,
): DecorateNode {
  return (node) => {
    const count = counts[node.id];
    if (count === undefined) return EMPTY_NODE_DECORATION;
    const summary = formatNodeLiveCount(count);
    if (summary === "") return EMPTY_NODE_DECORATION;
    const failedOnly = count.running + count.waiting === 0;
    return {
      borderColor: failedOnly
        ? colors.dangerFg
        : count.running > 0
          ? colors.accent
          : null,
      badge: liveBadge(count, summary),
      captionSuffix: summary,
      tooltip: summary,
    };
  };
}
