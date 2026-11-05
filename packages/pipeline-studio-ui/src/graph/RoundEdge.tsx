import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type EdgeProps,
} from "@xyflow/react";
import { fonts } from "@scarn/design-tokens";
import type { RoundEdgeTone, RoundLayoutEdge } from "./automation-round-layout";
import { palette, tint, TONE_COLOR } from "./graph-palette";

/** Routes are plain flow; soft links take the loop colour, the engine's are muted. */
export const ROUND_EDGE_COLOR: Record<RoundEdgeTone, string> = {
  route: TONE_COLOR.flow,
  declared: TONE_COLOR.loop,
  engine: palette.textMuted,
};

/** Routes solid, soft links dashed, engine links dotted. */
export const ROUND_EDGE_DASH: Record<RoundEdgeTone, string | undefined> = {
  route: undefined,
  declared: "6 4",
  engine: "2 4",
};

const LABEL_GAP = 14;

function polyline(points: readonly (readonly [number, number])[]): string {
  return points
    .map(
      ([x, y], index) => `${index === 0 ? "M" : "L"} ${String(x)} ${String(y)}`,
    )
    .join(" ");
}

type Placed = { path: string; labelX: number; labelY: number; anchor: string };

function placeEdge(props: EdgeProps<RoundLayoutEdge>): Placed {
  const { sourceX, sourceY, targetX, targetY, data } = props;
  if (data?.path === "back") {
    const sx = sourceX + (data.exitDx ?? 0);
    const tx = targetX + (data.enterDx ?? 0);
    const cy = data.channelY ?? Math.min(sourceY, targetY) - 30;
    return {
      path: polyline([
        [sx, sourceY],
        [sx, cy],
        [tx, cy],
        [tx, targetY],
      ]),
      labelX: (sx + tx) / 2,
      labelY: cy,
      anchor: "translate(-50%, -50%)",
    };
  }
  const [path] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition: props.sourcePosition,
    targetX,
    targetY,
    targetPosition: props.targetPosition,
  });
  return data?.labelAt === "target"
    ? {
        path,
        labelX: targetX - LABEL_GAP,
        labelY: targetY,
        anchor: "translate(-100%, -50%)",
      }
    : {
        path,
        labelX: sourceX + LABEL_GAP,
        labelY: sourceY,
        anchor: "translate(0, -50%)",
      };
}

/**
 * The automation round's edge renderer — registered as `edgeTypes.roundEdge`
 * in `AutomationRoundView.tsx`. Forward edges are beziers with the label
 * pinned next to one end (never all at a shared midpoint); back edges run up
 * to their own channel above the lanes and drop into the target from the top.
 */
export function RoundEdge(props: EdgeProps<RoundLayoutEdge>) {
  const { id, markerEnd, label, data } = props;
  const tone = data?.tone ?? "route";
  const stroke = ROUND_EDGE_COLOR[tone];
  const { path, labelX, labelY, anchor } = placeEdge(props);
  const text = typeof label === "string" ? label : undefined;

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        style={{
          stroke,
          strokeWidth: 1.5,
          strokeDasharray: ROUND_EDGE_DASH[tone],
        }}
      />
      {text ? (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan"
            title={text}
            data-edge-label={id}
            style={{
              position: "absolute",
              transform: `${anchor} translate(${String(labelX)}px, ${String(labelY)}px)`,
              display: "flex",
              alignItems: "center",
              padding: "2px 8px",
              borderRadius: 999,
              background: palette.bg,
              border: `1px solid ${tint(stroke, 55)}`,
              color: tone === "route" ? palette.textMuted : stroke,
              fontFamily: fonts.mono,
              fontSize: 11,
              lineHeight: "16px",
              whiteSpace: "nowrap",
              pointerEvents: "all",
            }}
          >
            {text}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}
