"use client";

import { useMemo } from "react";
import {
  EMPTY_EDGE_DECORATION,
  EMPTY_NODE_DECORATION,
  PipelineGraphView as SharedPipelineGraphView,
  type DecorateEdge,
  type DecorateNode,
} from "@scarn/pipeline-studio-ui/view";
import type { StudioEdge, StudioNode } from "@scarn/pipeline-studio-ui";
import { colors } from "@scarn/design-tokens";
import type { NodeVisualStatus } from "./pipeline-graph-node-status";
import {
  overruleEdgeOverlay,
  runDecorators,
  type EdgeOverruleMark,
} from "./pipeline-graph-run-decoration";

const UNDECORATED: { decorateNode: DecorateNode; decorateEdge: DecorateEdge } =
  {
    decorateNode: () => EMPTY_NODE_DECORATION,
    decorateEdge: () => EMPTY_EDGE_DECORATION,
  };

/**
 * The web app's pipeline graph: the shared `PipelineGraphView` from
 * `@scarn/pipeline-studio-ui/view`, decorated with run status rather than
 * validation issues, with a minimap for large graphs.
 *
 * `getNodeStatus` is the seam that keeps this reusable beyond one
 * execution's page: a caller viewing an attempt closes over its visits (see
 * `computeNodeVisualStatus`); without it the graph shows the bare
 * definition. `decorateNode` replaces the run-status look outright, e.g.
 * with live counts across many runs. `isExpanded` re-fits the view when its container is expanded
 * or collapsed.
 */
export function PipelineGraphView({
  nodes,
  edges,
  getNodeStatus,
  decorateNode: decorateNodeOverride,
  onSelectNode,
  onDeselect,
  isExpanded = false,
  highlightedNodeId = null,
  edgeMarks,
}: {
  nodes: StudioNode[];
  edges: StudioEdge[];
  getNodeStatus?: (nodeId: string) => NodeVisualStatus;
  decorateNode?: DecorateNode;
  onSelectNode?: (nodeId: string) => void;
  onDeselect?: () => void;
  isExpanded?: boolean;
  /** A node drawn with a bright border, e.g. the one a hovered visit ran. */
  highlightedNodeId?: string | null;
  /** Routes a person overruled, keyed by `edgeMarkKey`. */
  edgeMarks?: ReadonlyMap<string, EdgeOverruleMark>;
}) {
  const { decorateNode, decorateEdge } = useMemo(() => {
    const base = getNodeStatus ? runDecorators(getNodeStatus) : UNDECORATED;
    return decorateNodeOverride
      ? { ...base, decorateNode: decorateNodeOverride }
      : base;
  }, [getNodeStatus, decorateNodeOverride]);
  const decorateMarkedEdge = useMemo<DecorateEdge>(() => {
    if (!edgeMarks || edgeMarks.size === 0) return decorateEdge;
    const overlay = overruleEdgeOverlay(edgeMarks);
    return (edge) => overlay(edge, decorateEdge(edge));
  }, [decorateEdge, edgeMarks]);
  const decorateHighlighted = useMemo<DecorateNode>(
    () =>
      highlightedNodeId === null
        ? decorateNode
        : (node) => {
            const decoration = decorateNode(node);
            return node.id === highlightedNodeId
              ? { ...decoration, borderColor: colors.text }
              : decoration;
          },
    [decorateNode, highlightedNodeId],
  );

  return (
    <SharedPipelineGraphView
      nodes={nodes}
      edges={edges}
      decorateNode={decorateHighlighted}
      decorateEdge={decorateMarkedEdge}
      onSelectNode={onSelectNode}
      onDeselect={onDeselect}
      minimap
      refitKey={isExpanded}
    />
  );
}
