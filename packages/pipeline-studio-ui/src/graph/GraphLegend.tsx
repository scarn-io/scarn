import { Panel } from "@xyflow/react";
import { palette, TONE_COLOR } from "./graph-palette";
import type { StudioEdge } from "./studio-graph-types";
import {
  EDGE_LEGEND_LABEL,
  edgeDashArray,
  edgeLegendKinds,
  type EdgeLegendKind,
} from "./studio-graph-visuals";

const LEGEND_STROKE: Record<EdgeLegendKind, { color: string; dash?: string }> = {
  flow: { color: TONE_COLOR.flow },
  loop: { color: TONE_COLOR.loop },
  catch: { color: TONE_COLOR.catch, dash: edgeDashArray({ kind: "catch", lane: null }) },
  each: { color: TONE_COLOR.flow, dash: edgeDashArray({ kind: "route", lane: "each" }) },
  handoff: { color: TONE_COLOR.flow, dash: edgeDashArray({ kind: "handoff", lane: null }) },
};

/**
 * A compact key for the edge styles in the graph, pinned to the top-right
 * corner. Hidden when the graph only has plain "next" edges.
 */
export function GraphLegend({ edges }: { edges: readonly StudioEdge[] }) {
  const kinds = edgeLegendKinds(edges);
  if (kinds.length < 2) return null;
  return (
    <Panel position="top-right">
      <div
        style={{
          display: "flex",
          gap: 12,
          padding: "6px 10px",
          borderRadius: 6,
          border: `1px solid ${palette.border}`,
          background: palette.bgElev,
          fontSize: 11,
          color: palette.textMuted,
        }}
      >
        {kinds.map((kind) => (
          <span key={kind} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <svg width="22" height="6" aria-hidden>
              <line
                x1="0"
                y1="3"
                x2="22"
                y2="3"
                stroke={LEGEND_STROKE[kind].color}
                strokeWidth="1.5"
                strokeDasharray={LEGEND_STROKE[kind].dash}
              />
            </svg>
            {EDGE_LEGEND_LABEL[kind]}
          </span>
        ))}
      </div>
    </Panel>
  );
}
