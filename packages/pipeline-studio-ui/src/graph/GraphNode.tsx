import type { CSSProperties } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { fonts } from "@scarn/design-tokens";
import type { NodeBadge, NodeDecoration } from "./graph-decoration";
import {
  FLOW_SOURCE_HANDLE,
  FLOW_TARGET_HANDLE,
  LOOP_SOURCE_HANDLE,
  LOOP_TARGET_HANDLE,
} from "./edge-route";
import { GraphIcon, type GraphIconName } from "./graph-icons";
import { palette, tint } from "./graph-palette";
import type { StudioNodeData } from "./studio-graph-types";
import {
  forkMarker,
  kindLabel,
  mergeBadge,
  nodeLayoutSize,
} from "./studio-graph-visuals";

/** A node's data with its host app's decoration resolved onto it (see `PipelineGraphView`). */
export type GraphNodeData = StudioNodeData & { decoration: NodeDecoration };
export type GraphNodeType = Node<GraphNodeData>;

type NodeKind = StudioNodeData["kind"];

/**
 * Each node kind's icon and identity color. Kind color only tints the icon
 * chip and the card's left stripe; the host's decoration keeps its own
 * channel (the corner badge and the border), so the two signals never
 * compete.
 */
const KIND_STYLE: Record<NodeKind, { icon: GraphIconName; color: string }> = {
  start: { icon: "start", color: palette.textMuted },
  step: { icon: "step", color: palette.accent },
  wait: { icon: "wait", color: palette.attention },
  succeed: { icon: "succeed", color: palette.success },
  fail: { icon: "fail", color: palette.danger },
};

const truncate: CSSProperties = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

function selectionShadow(selected: boolean): string {
  return selected ? `0 0 0 2px ${palette.accent}, ${palette.shadow}` : palette.shadow;
}

const BADGE_SIZE = 20;

const badgeFrame: CSSProperties = {
  position: "absolute",
  top: -8,
  right: -8,
  minWidth: BADGE_SIZE,
  height: BADGE_SIZE,
  boxSizing: "border-box",
  borderRadius: BADGE_SIZE / 2,
  border: `2px solid ${palette.bg}`,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1,
};

/** The corner badge overlapping the card's top-right corner. */
function Badge({ badge }: { badge: NodeBadge | null }) {
  if (!badge) return null;
  switch (badge.kind) {
    case "spinner":
      return (
        <div aria-label={badge.label} style={{ ...badgeFrame, background: palette.bgElev }}>
          <svg
            className="pipeline-graph-spinner"
            width={12}
            height={12}
            viewBox="0 0 12 12"
            aria-hidden
          >
            <circle
              cx={6}
              cy={6}
              r={4.5}
              fill="none"
              stroke={palette.accent}
              strokeWidth={2}
              strokeDasharray="18 10"
              strokeLinecap="round"
            />
          </svg>
        </div>
      );
    case "icon":
      return (
        <div aria-label={badge.label} style={{ ...badgeFrame, background: badge.color }}>
          <GraphIcon name={badge.icon} size={13} color="#fff" />
        </div>
      );
    case "count":
      return (
        <span
          aria-label={badge.label}
          style={{
            ...badgeFrame,
            padding: "0 5px",
            background: badge.color,
            color: "#fff",
            fontSize: 11,
            fontWeight: 700,
            lineHeight: "16px",
          }}
        >
          {badge.count}
        </span>
      );
  }
}

/** The spinner's rotation, injected once next to it rather than via a host stylesheet. */
const SPINNER_CSS =
  "@keyframes pipeline-graph-spin{to{transform:rotate(360deg)}}" +
  ".pipeline-graph-spinner{animation:pipeline-graph-spin 0.8s linear infinite}";

/**
 * Handles are only anchors for edges in this read-only view, so they're
 * invisible. Flow edges use the top/bottom pair; loop edges use the
 * right-side pair, the outgoing one below the incoming one so a self loop
 * reads as a clockwise hook.
 */
const hiddenHandle: CSSProperties = {
  opacity: 0,
  width: 6,
  height: 6,
  minWidth: 0,
  minHeight: 0,
  border: "none",
  pointerEvents: "none",
};

function NodeHandles({ kind }: { kind: NodeKind }) {
  const hasInput = kind !== "start";
  const hasOutput = kind === "start" || kind === "step" || kind === "wait";
  return (
    <>
      {hasInput ? (
        <>
          <Handle
            id={FLOW_TARGET_HANDLE}
            type="target"
            position={Position.Top}
            isConnectable={false}
            style={hiddenHandle}
          />
          <Handle
            id={LOOP_TARGET_HANDLE}
            type="target"
            position={Position.Right}
            isConnectable={false}
            style={{ ...hiddenHandle, top: "30%" }}
          />
        </>
      ) : null}
      {hasOutput ? (
        <>
          <Handle
            id={FLOW_SOURCE_HANDLE}
            type="source"
            position={Position.Bottom}
            isConnectable={false}
            style={hiddenHandle}
          />
          <Handle
            id={LOOP_SOURCE_HANDLE}
            type="source"
            position={Position.Right}
            isConnectable={false}
            style={{ ...hiddenHandle, top: "70%" }}
          />
        </>
      ) : null}
    </>
  );
}

/** A small tag line under a step's caption: its fork mode or what it merges. */
function NodeTag({ icon, text }: { icon: GraphIconName; text: string }) {
  return (
    <div
      title={text}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 4,
        fontSize: 11,
        lineHeight: "16px",
        color: palette.textMuted,
        minWidth: 0,
      }}
    >
      <GraphIcon name={icon} size={12} color={palette.textDim} />
      <span style={truncate}>{text}</span>
    </div>
  );
}

function cardCaption(data: GraphNodeData): string {
  const { captionPrefix, captionSuffix } = data.decoration;
  return [captionPrefix, kindLabel(data), captionSuffix]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
}

/**
 * The pipeline graph's node renderer — registered as `nodeTypes.pipelineNode`
 * in `PipelineGraphView.tsx`. Each kind has its own silhouette, sized by
 * `nodeLayoutSize` so edges meet the card exactly:
 *
 * - **start** — a compact pill;
 * - **step / wait** — a card with a kind-colored left stripe and icon chip,
 *   the node's title and caption, a fork tag on a `match: "all"` node and a
 *   merge tag on a merge node;
 * - **succeed / fail** — a rounded terminal pill tinted green or red.
 *
 * The host's `NodeDecoration` (run status, validation issues) shows as the
 * border color, a corner badge and caption text.
 */
export function GraphNode({ data, selected }: NodeProps<GraphNodeType>) {
  const { decoration } = data;
  const { icon, color } = KIND_STYLE[data.kind];
  const size = nodeLayoutSize(data);
  const border = decoration.borderColor;
  const title = decoration.tooltip ? `${data.label} — ${decoration.tooltip}` : data.label;
  const badge = (
    <>
      {decoration.badge?.kind === "spinner" ? <style>{SPINNER_CSS}</style> : null}
      <Badge badge={decoration.badge} />
    </>
  );

  if (data.kind === "start") {
    return (
      <div
        className="pipeline-graph-node"
        data-kind="start"
        aria-label="Start"
        title="Start"
        style={{
          ...size,
          boxSizing: "border-box",
          borderRadius: size.height / 2,
          border: `1px solid ${palette.borderStrong}`,
          background: palette.bgElev,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 6,
          fontSize: 12,
          fontWeight: 600,
          letterSpacing: "0.04em",
          textTransform: "uppercase",
          color: palette.textMuted,
          boxShadow: selectionShadow(selected),
        }}
      >
        <GraphIcon name={icon} size={16} color={palette.textMuted} />
        Start
        <NodeHandles kind="start" />
      </div>
    );
  }

  if (data.kind === "succeed" || data.kind === "fail") {
    return (
      <div
        className="pipeline-graph-node"
        data-kind={data.kind}
        data-selected={selected ? "true" : undefined}
        title={title}
        style={{
          ...size,
          boxSizing: "border-box",
          position: "relative",
          borderRadius: size.height / 2,
          border: `1px solid ${border ?? tint(color, 45)}`,
          background: `linear-gradient(${tint(color, 10)}, ${tint(color, 10)}), ${palette.bgElev}`,
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "0 14px 0 8px",
          boxShadow: selectionShadow(selected),
        }}
      >
        {badge}
        <div
          style={{
            flexShrink: 0,
            width: 26,
            height: 26,
            borderRadius: "50%",
            background: tint(color, 18),
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <GraphIcon name={icon} size={16} color={color} />
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div
            style={{
              ...truncate,
              fontWeight: 600,
              fontSize: 13,
              lineHeight: "16px",
              color: palette.text,
            }}
          >
            {data.label}
          </div>
          <div
            style={{
              fontSize: 10,
              lineHeight: "12px",
              fontWeight: 600,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              color,
            }}
          >
            {kindLabel(data)}
          </div>
        </div>
        <NodeHandles kind={data.kind} />
      </div>
    );
  }

  const caption = cardCaption(data);
  const fork = forkMarker(data);
  const merge = mergeBadge(data);

  return (
    <div
      className="pipeline-graph-node"
      data-kind={data.kind}
      data-match={data.match}
      data-selected={selected ? "true" : undefined}
      title={title}
      style={{
        ...size,
        boxSizing: "border-box",
        position: "relative",
        border: `1px solid ${border ?? palette.border}`,
        borderLeft: `3px solid ${border ?? color}`,
        borderRadius: 8,
        padding: "0 10px",
        background: palette.bgElev,
        display: "flex",
        alignItems: "center",
        gap: 10,
        boxShadow: selectionShadow(selected),
      }}
    >
      {badge}
      <div
        style={{
          flexShrink: 0,
          width: 30,
          height: 30,
          borderRadius: 6,
          background: tint(color, 12),
          border: `1px solid ${tint(color, 30)}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <GraphIcon name={icon} size={17} color={color} />
      </div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div
          style={{
            ...truncate,
            fontWeight: 600,
            fontSize: 13,
            lineHeight: "17px",
            color: palette.text,
          }}
        >
          {data.label}
        </div>
        <div
          title={caption}
          style={{
            ...truncate,
            fontSize: 11,
            lineHeight: "15px",
            color: palette.textMuted,
            fontFamily: data.kind === "step" ? fonts.mono : undefined,
          }}
        >
          {caption}
        </div>
        {fork ? <NodeTag icon="fork" text={fork} /> : null}
        {merge ? <NodeTag icon="merge" text={merge} /> : null}
      </div>
      <NodeHandles kind={data.kind} />
    </div>
  );
}
