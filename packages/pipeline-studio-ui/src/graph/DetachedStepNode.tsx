import type { NodeProps } from "@xyflow/react";
import { fonts } from "@scarn/design-tokens";
import { GraphIcon } from "./graph-icons";
import { palette } from "./graph-palette";
import { selectionShadow, truncate, type GraphNodeType } from "./GraphNode";
import {
  DETACHED_DASH_ARRAY,
  kindLabel,
  nodeLayoutSize,
} from "./studio-graph-visuals";

const [DASH, GAP] = DETACHED_DASH_ARRAY.split(" ").map(Number);

/**
 * A step the template's file exports but no graph runs, registered as
 * `nodeTypes.detachedNode` in `PipelineGraphView.tsx`: an automation's
 * steps, or steps an agent starts by key. Drawn as a dashed, transparent card
 * with no handles, so it never reads as a node the engine runs. Its border is
 * an SVG rect, since CSS `dashed` borders can't take a dash length.
 */
export function DetachedStepNode({ data, selected }: NodeProps<GraphNodeType>) {
  const size = nodeLayoutSize(data);

  return (
    <div
      className="pipeline-graph-node"
      data-kind="detached"
      data-selected={selected ? "true" : undefined}
      title={`${data.label} — not run by a pipeline graph`}
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
    </div>
  );
}
