import type { GraphIconName } from "./graph-icons";
import { palette } from "./graph-palette";
import type { StudioNodeData } from "./studio-graph-types";

type NodeKind = StudioNodeData["kind"];

export type NodeKindStyle = { icon: GraphIconName; color: string };

/**
 * Each node kind's icon and identity color. Kind color only tints the icon
 * chip and the card's left stripe; the host's decoration keeps its own
 * channel (the corner badge and the border), so the two signals never
 * compete.
 */
const KIND_STYLE: Record<NodeKind, NodeKindStyle> = {
  start: { icon: "start", color: palette.textMuted },
  step: { icon: "step", color: palette.accent },
  wait: { icon: "wait", color: palette.attention },
  succeed: { icon: "succeed", color: palette.success },
  fail: { icon: "fail", color: palette.danger },
  detached: { icon: "step", color: palette.textMuted },
  event: { icon: "event", color: palette.attention },
  rule: { icon: "rule", color: palette.textMuted },
  pipeline: { icon: "pipeline", color: palette.done },
  action: { icon: "step", color: palette.accent },
};

const ACTION_STYLE: Record<
  NonNullable<StudioNodeData["actionKind"]>,
  NodeKindStyle
> = {
  step: KIND_STYLE.action,
  attach: { icon: "attach", color: palette.violet },
  skip: { icon: "skip", color: palette.textMuted },
};

/** A node's icon and identity color; an action node's follow what it does. */
export function nodeKindStyle(
  data: Pick<StudioNodeData, "kind" | "actionKind">,
): NodeKindStyle {
  if (data.kind === "action" && data.actionKind !== undefined) {
    return ACTION_STYLE[data.actionKind];
  }
  return KIND_STYLE[data.kind];
}

/** Whether edges can enter a node of this kind (all but the graph's entry points). */
export function hasInputHandle(kind: NodeKind): boolean {
  return kind !== "start" && kind !== "event";
}

/** Whether edges can leave a node of this kind (all but terminal nodes and route targets). */
export function hasOutputHandle(kind: NodeKind): boolean {
  switch (kind) {
    case "start":
    case "step":
    case "wait":
    case "event":
    case "rule":
      return true;
    case "succeed":
    case "fail":
    case "detached":
    case "pipeline":
    case "action":
      return false;
  }
}
