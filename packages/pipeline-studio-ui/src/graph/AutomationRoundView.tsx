import { useMemo, type CSSProperties } from "react";
import {
  Background,
  Controls,
  MarkerType,
  ReactFlow,
  ReactFlowProvider,
  type EdgeTypes,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  layoutAutomationRound,
  type RoundLayoutEdge,
} from "./automation-round-layout";
import type { AutomationRoundModel } from "./automation-round-types";
import { palette } from "./graph-palette";
import { RoundEdge, ROUND_EDGE_COLOR } from "./RoundEdge";
import {
  EndNode,
  JunctionNode,
  LaneNode,
  PersonNode,
  RoundCardNode,
} from "./RoundNodes";

const nodeTypes: NodeTypes = {
  lane: LaneNode,
  junction: JunctionNode,
  step: RoundCardNode,
  pipeline: RoundCardNode,
  attach: RoundCardNode,
  person: PersonNode,
  end: EndNode,
};
const edgeTypes: EdgeTypes = { roundEdge: RoundEdge };

const controlsStyle = {
  "--xy-controls-button-background-color": palette.bgElev,
  "--xy-controls-button-background-color-hover": palette.bg,
  "--xy-controls-button-border-color": palette.border,
  "--xy-controls-button-color": palette.textMuted,
  "--xy-controls-button-color-hover": palette.text,
  "--xy-controls-box-shadow": `0 0 0 1px ${palette.border}`,
} as CSSProperties;

const FIT_VIEW_OPTIONS = { padding: 0.08, maxZoom: 1 };

/**
 * Renders one automation as one round (`buildAutomationRound`), laid out in
 * swimlanes by `layoutAutomationRound`. Read-only, like `PipelineGraphView`:
 * nodes can't be dragged or connected. `onSelectNode` fires with the round
 * node's id on a click on anything but a lane; `onDeselect` on the canvas.
 */
export function AutomationRoundView({
  model,
  onSelectNode,
  onDeselect,
  colorMode = "dark",
}: {
  model: AutomationRoundModel;
  onSelectNode?: (nodeId: string) => void;
  onDeselect?: () => void;
  colorMode?: "light" | "dark";
}) {
  const layout = useMemo(() => layoutAutomationRound(model), [model]);
  const edges = useMemo<RoundLayoutEdge[]>(
    () =>
      layout.edges.map((edge) => ({
        ...edge,
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: ROUND_EDGE_COLOR[edge.data?.tone ?? "route"],
          width: 16,
          height: 16,
        },
      })),
    [layout],
  );

  return (
    <ReactFlowProvider initialNodes={layout.nodes} initialEdges={edges}>
      <ReactFlow
        colorMode={colorMode}
        nodes={layout.nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodeClick={(_event, node) => {
          if (node.data.kind !== "lane") onSelectNode?.(node.id);
        }}
        onPaneClick={() => {
          onDeselect?.();
        }}
        fitView
        fitViewOptions={FIT_VIEW_OPTIONS}
        minZoom={0.05}
        nodesDraggable={false}
        nodesConnectable={false}
      >
        <Background color={palette.border} bgColor={palette.bg} gap={20} />
        <Controls style={controlsStyle} showInteractive={false} />
      </ReactFlow>
    </ReactFlowProvider>
  );
}
