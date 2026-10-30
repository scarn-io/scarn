import { BaseEdge, type EdgeProps } from "@xyflow/react";
import { routeEdge } from "./edge-route";
import type { StudioEdge } from "./studio-graph-types";
import {
  edgeDashArray,
  highestSeverity,
  orderedEdgeLabel,
  severityColor,
} from "./studio-graph-visuals";

/**
 * The studio's custom edge renderer — registered as `edgeTypes.default` in
 * `PipelineGraphView.tsx`. The routed path the layout computed (see
 * `routeEdge`: forward edges step down through their label slot, loops run up
 * a lane beside the graph), colored by
 * `highestSeverity(data.issues)`, dashed for `catch` edges and dotted for
 * `each` edges (see `edgeDashArray`). Routes of a `first` node are numbered
 * in check order; routes of an `all` node aren't (see `orderedEdgeLabel`).
 */
export function StudioGraphEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  markerEnd,
  label,
  data,
}: EdgeProps<StudioEdge>) {
  const { path, labelX, labelY } = routeEdge(
    data?.route,
    { x: sourceX, y: sourceY },
    { x: targetX, y: targetY },
  );
  const severity = highestSeverity(data?.issues ?? []);

  return (
    <BaseEdge
      id={id}
      path={path}
      markerEnd={markerEnd}
      label={orderedEdgeLabel(
        typeof label === "string" ? label : undefined,
        data?.order ?? null,
      )}
      labelX={labelX}
      labelY={labelY}
      style={{
        strokeDasharray: edgeDashArray(data),
        ...(severity
          ? { stroke: severityColor(severity), strokeWidth: 2 }
          : {}),
      }}
    />
  );
}
