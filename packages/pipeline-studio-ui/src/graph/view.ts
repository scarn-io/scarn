/**
 * The `./view` entry: the shared pipeline graph component and what a host
 * needs to decorate it. Separate from `"."` because it pulls in React and
 * the React Flow runtime, which `"."`'s server-side consumers must not.
 */
export { PipelineGraphView } from "./PipelineGraphView";
export {
  EMPTY_EDGE_DECORATION,
  EMPTY_NODE_DECORATION,
  decorateEdgeWithIssues,
  decorateNodeWithIssues,
  type DecorateEdge,
  type DecorateNode,
  type EdgeDecoration,
  type NodeBadge,
  type NodeDecoration,
} from "./graph-decoration";
export type { GraphIconName } from "./graph-icons";
export { palette as graphPalette } from "./graph-palette";
