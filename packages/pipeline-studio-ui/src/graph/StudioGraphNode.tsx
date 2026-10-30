import { Handle, Position, type NodeProps } from "@xyflow/react";
import {
  FLOW_SOURCE_HANDLE,
  FLOW_TARGET_HANDLE,
  LOOP_SOURCE_HANDLE,
  LOOP_TARGET_HANDLE,
} from "./edge-route";
import type { StudioNode } from "./studio-graph-types";
import {
  forkMarker,
  formatInOutCounts,
  highestSeverity,
  mergeBadge,
  nodeCaption,
  nodeInOutCounts,
  severityColor,
} from "./studio-graph-visuals";

/**
 * The studio's custom node renderer — registered as `nodeTypes.default` in
 * `PipelineGraphView.tsx`, so every `StudioNode` renders through here.
 *
 * Shows the node label, a kind caption (`step · <step key>`,
 * `wait · decision`, ...), the "N in · M out" schema field counts for step
 * nodes whose step is known, a fork marker on `match: "all"` nodes, a
 * "merges: …" badge on merge nodes, and an issue-count badge when
 * `data.issues` is non-empty. The border is colored by `highestSeverity(data.issues)`. The
 * synthetic start node renders as a small dot with no target handle.
 *
 * Top/bottom handles match `translateDocumentToGraph`'s `rankdir: "TB"`.
 */
export function StudioGraphNode({ data, selected }: NodeProps<StudioNode>) {
  if (data.kind === "start") {
    return (
      <div className="studio-node-start" aria-label="Start">
        <Handle
          id={FLOW_SOURCE_HANDLE}
          type="source"
          position={Position.Bottom}
          isConnectable={false}
        />
      </div>
    );
  }

  const severity = highestSeverity(data.issues);
  const counts = nodeInOutCounts(data.shape);
  const fork = forkMarker(data);
  const merge = mergeBadge(data);

  return (
    <div
      className="studio-node"
      data-kind={data.kind}
      data-severity={severity ?? "none"}
      data-match={data.match}
      data-selected={selected ? "true" : undefined}
      style={{ borderColor: severityColor(severity) }}
    >
      <Handle
        id={FLOW_TARGET_HANDLE}
        type="target"
        position={Position.Top}
        isConnectable={false}
      />
      <Handle
        id={LOOP_TARGET_HANDLE}
        type="target"
        position={Position.Right}
        isConnectable={false}
        style={{ top: "30%", opacity: 0 }}
      />
      {data.issues.length > 0 ? (
        <span
          className="studio-node-badge"
          style={{ background: severityColor(severity) }}
          aria-label={`${String(data.issues.length)} validation issue(s)`}
        >
          {data.issues.length}
        </span>
      ) : null}
      {merge ? <div className="studio-node-merge">{merge}</div> : null}
      <div className="studio-node-label">{data.label}</div>
      <div className="studio-node-kind">{nodeCaption(data)}</div>
      {counts ? (
        <div className="studio-node-counts">{formatInOutCounts(counts)}</div>
      ) : null}
      {fork ? <div className="studio-node-fork">{fork}</div> : null}
      {data.kind === "step" || data.kind === "wait" ? (
        <>
          <Handle
            id={FLOW_SOURCE_HANDLE}
            type="source"
            position={Position.Bottom}
            isConnectable={false}
          />
          <Handle
            id={LOOP_SOURCE_HANDLE}
            type="source"
            position={Position.Right}
            isConnectable={false}
            style={{ top: "70%", opacity: 0 }}
          />
        </>
      ) : null}
    </div>
  );
}
