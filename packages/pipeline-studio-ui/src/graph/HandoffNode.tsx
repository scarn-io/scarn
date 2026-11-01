import { Handle, Position, type NodeProps } from "@xyflow/react";
import { fonts } from "@scarn/design-tokens";
import { HANDOFF_SOURCE_HANDLE, HANDOFF_TARGET_HANDLE } from "./edge-route";
import { GraphIcon } from "./graph-icons";
import { palette } from "./graph-palette";
import {
  hiddenHandle,
  selectionShadow,
  truncate,
  type GraphNodeType,
} from "./GraphNode";
import {
  HANDOFF_DASH_ARRAY,
  kindLabel,
  nodeLayoutSize,
} from "./studio-graph-visuals";

const [DASH, GAP] = HANDOFF_DASH_ARRAY.split(" ").map(Number);

/**
 * A step an agent starts during its run, registered as
 * `nodeTypes.handoffNode` in `PipelineGraphView.tsx`. Drawn as a dashed,
 * transparent card so it never reads as a graph node the engine runs; its
 * only outgoing handle, on top, carries the dashed "resumes" edge back to its
 * starter. Its border is an SVG rect, since CSS `dashed` borders can't take a
 * dash length.
 */
export function HandoffNode({ data, selected }: NodeProps<GraphNodeType>) {
  const size = nodeLayoutSize(data);
  const summary = data.handoff?.summary ?? "";
  const startedBy = data.handoff?.startedBy;
  const title = startedBy
    ? `${data.label} — started by ${startedBy} during a round; ${startedBy} resumes when its ticket closes`
    : data.label;

  return (
    <div
      className="pipeline-graph-node"
      data-kind="handoff"
      data-selected={selected ? "true" : undefined}
      title={summary ? `${title}\n${summary}` : title}
      style={{
        ...size,
        boxSizing: "border-box",
        position: "relative",
        borderRadius: 8,
        padding: "8px 12px",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        gap: 2,
        boxShadow: selected ? selectionShadow(true) : undefined,
      }}
    >
      <svg
        aria-hidden
        width={size.width}
        height={size.height}
        style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
      >
        <rect
          x={0.75}
          y={0.75}
          width={size.width - 1.5}
          height={size.height - 1.5}
          rx={8}
          fill="none"
          stroke={palette.borderStrong}
          strokeWidth={1.5}
          strokeDasharray={`${String(DASH ?? 8)} ${String(GAP ?? 5)}`}
        />
      </svg>
      <div
        style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}
      >
        <GraphIcon name="step" size={14} color={palette.textMuted} />
        <span
          style={{
            ...truncate,
            fontWeight: 600,
            fontSize: 13,
            lineHeight: "17px",
            color: palette.text,
          }}
        >
          {data.label}
        </span>
      </div>
      <div
        style={{
          ...truncate,
          fontSize: 11,
          lineHeight: "15px",
          color: palette.textMuted,
          fontFamily: fonts.mono,
        }}
      >
        {kindLabel(data)}
      </div>
      {summary ? (
        <div
          style={{
            ...truncate,
            fontSize: 11,
            lineHeight: "15px",
            color: palette.textDim,
          }}
        >
          {summary}
        </div>
      ) : null}
      <Handle
        id={HANDOFF_TARGET_HANDLE}
        type="target"
        position={Position.Left}
        isConnectable={false}
        style={hiddenHandle}
      />
      <Handle
        id={HANDOFF_SOURCE_HANDLE}
        type="source"
        position={Position.Top}
        isConnectable={false}
        style={hiddenHandle}
      />
    </div>
  );
}
