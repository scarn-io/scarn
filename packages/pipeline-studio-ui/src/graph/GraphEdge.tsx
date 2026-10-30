import {
  BaseEdge,
  EdgeLabelRenderer,
  type Edge,
  type EdgeProps,
} from "@xyflow/react";
import { fonts } from "@scarn/design-tokens";
import { routeEdge } from "./edge-route";
import type { EdgeDecoration } from "./graph-decoration";
import { GraphIcon } from "./graph-icons";
import { palette, tint, TONE_COLOR } from "./graph-palette";
import type { StudioEdgeData } from "./studio-graph-types";
import {
  edgeDashArray,
  edgeTone,
  orderedEdgeLabel,
} from "./studio-graph-visuals";

/** An edge's data with its host app's decoration resolved onto it (see `PipelineGraphView`). */
export type GraphEdgeData = Partial<StudioEdgeData> & { decoration: EdgeDecoration };
export type GraphEdgeType = Edge<GraphEdgeData>;

/**
 * The pipeline graph's edge renderer — registered as `edgeTypes.pipelineEdge`
 * in `PipelineGraphView.tsx`. Draws the route the layout computed (see
 * `routeEdge`): forward edges step down through their own label slot, loop
 * edges run up a lane to the right of everything they pass.
 *
 * Catch edges are dashed red, loop edges purple with a replay icon on their
 * label, and `each` lanes dotted, so each kind of transition reads at a
 * glance. The host's `EdgeDecoration` can recolor an edge and emphasize it
 * (a traversed edge in a run, an edge with validation issues).
 *
 * The label is an HTML pill in React Flow's label layer, centred on the slot
 * the layout reserved for it, with the full text in its tooltip. Routes of a
 * `first` node are numbered in check order (see `orderedEdgeLabel`).
 */
export function GraphEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  markerEnd,
  label,
  data,
}: EdgeProps<GraphEdgeType>) {
  const { path, labelX, labelY } = routeEdge(
    data?.route,
    { x: sourceX, y: sourceY },
    { x: targetX, y: targetY },
  );
  const tone = edgeTone(data);
  const decoration = data?.decoration ?? {};
  const stroke = decoration.strokeColor ?? TONE_COLOR[tone];
  const emphasized = decoration.emphasized === true;
  const plainColor = tone === "flow" && !decoration.strokeColor;
  const text = orderedEdgeLabel(
    typeof label === "string" ? label : undefined,
    data?.order ?? null,
  );

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        style={{
          stroke,
          strokeWidth: emphasized ? 2 : 1.5,
          strokeDasharray: edgeDashArray(data),
        }}
      />
      {text ? (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan"
            title={text}
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${String(labelX)}px, ${String(labelY)}px)`,
              display: "flex",
              alignItems: "center",
              gap: 4,
              padding: "2px 8px",
              borderRadius: 999,
              background: palette.bg,
              border: `1px solid ${tint(stroke, 55)}`,
              color:
                decoration.labelColor ??
                (plainColor ? palette.textMuted : stroke),
              fontFamily: fonts.mono,
              fontSize: 11,
              lineHeight: "16px",
              whiteSpace: "nowrap",
              pointerEvents: "all",
            }}
          >
            {tone === "loop" ? (
              <GraphIcon name="loop" size={12} color="currentColor" />
            ) : null}
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
              {text}
            </span>
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}
