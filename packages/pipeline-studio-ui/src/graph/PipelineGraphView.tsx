import { useEffect, useMemo, type CSSProperties } from "react";
import {
  Background,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  getViewportForBounds,
  useReactFlow,
  useStoreApi,
  type EdgeTypes,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { graphBounds } from "./edge-route";
import {
  decorateEdgeWithIssues,
  decorateNodeWithIssues,
  edgeStroke,
  type DecorateEdge,
  type DecorateNode,
} from "./graph-decoration";
import { GraphEdge, type GraphEdgeType } from "./GraphEdge";
import { GraphLegend } from "./GraphLegend";
import { GraphNode, type GraphNodeType } from "./GraphNode";
import { palette, tint } from "./graph-palette";
import type { StudioEdge, StudioNode } from "./studio-graph-types";
import { nodeLayoutSize } from "./studio-graph-visuals";

// Deliberately NOT keyed `"default"`: React Flow stamps
// `.react-flow__node-default` onto any node whose type resolves to
// `"default"`, and its stock stylesheet gives that class a white box, fixed
// width and padding that bleed around the custom card. Module-level so
// identity is stable across renders.
const nodeTypes: NodeTypes = { pipelineNode: GraphNode };
const edgeTypes: EdgeTypes = { pipelineEdge: GraphEdge };

/**
 * `<Controls>` has no per-button color props, so its buttons are themed
 * through React Flow's own `--xy-controls-*` custom properties.
 */
const controlsStyle = {
  "--xy-controls-button-background-color": palette.bgElev,
  "--xy-controls-button-background-color-hover": palette.bg,
  "--xy-controls-button-border-color": palette.border,
  "--xy-controls-button-color": palette.textMuted,
  "--xy-controls-button-color-hover": palette.text,
  "--xy-controls-box-shadow": `0 0 0 1px ${palette.border}`,
} as CSSProperties;

/** Small graphs aren't blown up past life size; large ones keep a margin. */
const FIT_VIEW_OPTIONS = { padding: 0.08, maxZoom: 1 };

/** Only graphs too big to read at a glance get a minimap; on smaller ones it just covers nodes. */
const MINIMAP_NODE_THRESHOLD = 14;

function minimapNodeColor(node: GraphNodeType): string {
  const { decoration } = node.data;
  return decoration.minimapColor ?? decoration.borderColor ?? palette.border;
}

/**
 * Fits the viewport to `graphBounds` — the nodes plus the loop lanes and
 * edge labels that stick out past them, which React Flow's own `fitView`
 * (nodes only) would leave off screen — on mount, whenever the graph
 * changes, and whenever `refitKey` changes (e.g. its container was
 * expanded). React Flow tracks its container size on its own but never
 * re-runs the fit, so this does.
 *
 * Deliberately a nested `requestAnimationFrame`: a frame's rAF callbacks run
 * before its ResizeObserver notifications, so a single rAF after a container
 * resize would still measure the old size.
 */
function FitGraph({
  nodes,
  edges,
  refitKey,
}: {
  nodes: StudioNode[];
  edges: StudioEdge[];
  refitKey: unknown;
}) {
  const { setViewport, fitView } = useReactFlow();
  const store = useStoreApi();

  useEffect(() => {
    const bounds = graphBounds(nodes, edges);
    let innerFrame: number | undefined;
    const outerFrame = requestAnimationFrame(() => {
      innerFrame = requestAnimationFrame(() => {
        const { width, height, minZoom } = store.getState();
        if (!bounds || width === 0 || height === 0) {
          void fitView(FIT_VIEW_OPTIONS);
          return;
        }
        void setViewport(
          getViewportForBounds(
            bounds,
            width,
            height,
            minZoom,
            FIT_VIEW_OPTIONS.maxZoom,
            FIT_VIEW_OPTIONS.padding,
          ),
        );
      });
    });
    return () => {
      cancelAnimationFrame(outerFrame);
      if (innerFrame !== undefined) cancelAnimationFrame(innerFrame);
    };
  }, [refitKey, nodes, edges, setViewport, fitView, store]);

  return null;
}

/**
 * Renders one pipeline's translated graph via React Flow — the one graph
 * view shared by the local studio, the docs catalog and the web app.
 *
 * Every node and edge draws its kind's look; `decorateNode`/`decorateEdge`
 * are the seam where a host layers its own meaning on top. They default to
 * validation issues (`decorateNodeWithIssues`/`decorateEdgeWithIssues`); the
 * web app passes run status instead.
 *
 * `onSelectNode` fires on a node click, `onDeselect` on a click on the empty
 * canvas. `minimap` adds an overview for large graphs; `refitKey` re-fits
 * the view whenever it changes.
 */
export function PipelineGraphView({
  nodes,
  edges,
  decorateNode = decorateNodeWithIssues,
  decorateEdge = decorateEdgeWithIssues,
  onSelectNode,
  onDeselect,
  colorMode = "dark",
  minimap = false,
  refitKey,
}: {
  nodes: StudioNode[];
  edges: StudioEdge[];
  decorateNode?: DecorateNode;
  decorateEdge?: DecorateEdge;
  onSelectNode?: (nodeId: string) => void;
  onDeselect?: () => void;
  colorMode?: "light" | "dark";
  minimap?: boolean;
  refitKey?: unknown;
}) {
  const decoratedNodes = useMemo<GraphNodeType[]>(
    () =>
      nodes.map((node) => {
        const { width, height } = nodeLayoutSize(node.data);
        return {
          ...node,
          type: "pipelineNode",
          // The nodes never receive measured sizes back (no
          // `onNodesChange`), and `<MiniMap>` reads sizes off them.
          initialWidth: width,
          initialHeight: height,
          data: { ...node.data, decoration: decorateNode(node) },
        };
      }),
    [nodes, decorateNode],
  );

  const decoratedEdges = useMemo<GraphEdgeType[]>(
    () =>
      edges.map((edge) => {
        const decoration = decorateEdge(edge);
        return {
          ...edge,
          type: "pipelineEdge",
          data: { ...edge.data, decoration },
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color: edgeStroke(edge, decoration),
            width: 16,
            height: 16,
          },
        };
      }),
    [edges, decorateEdge],
  );

  return (
    <ReactFlowProvider>
      <ReactFlow
        colorMode={colorMode}
        nodes={decoratedNodes}
        edges={decoratedEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodeClick={(_event, node) => {
          onSelectNode?.(node.id);
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
        <FitGraph nodes={nodes} edges={edges} refitKey={refitKey} />
        <Background color={palette.border} bgColor={palette.bg} gap={20} />
        <Controls style={controlsStyle} showInteractive={false} />
        <GraphLegend edges={edges} />
        {minimap && nodes.length > MINIMAP_NODE_THRESHOLD ? (
          <MiniMap<GraphNodeType>
            style={{ width: 160, height: 110 }}
            pannable
            zoomable
            bgColor={palette.bgElev}
            maskColor={tint(palette.bg, 70)}
            nodeColor={minimapNodeColor}
            nodeStrokeColor={palette.borderStrong}
          />
        ) : null}
      </ReactFlow>
    </ReactFlowProvider>
  );
}
