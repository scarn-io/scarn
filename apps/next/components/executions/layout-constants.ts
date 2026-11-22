/**
 * Shared layout constants for the execution detail page, a fixed-viewport
 * page whose step rail and main each scroll inside their own container.
 */

/** Width of the desktop run rail: wider in Graph mode to fit the graph. */
export const RUN_RAIL_WIDTH = { list: 380, graph: 480 } as const;

/**
 * Height of the run overview's pipeline graph container. React Flow
 * (`PipelineGraphView`) requires an explicitly-sized parent to render into —
 * see `execution-overview.tsx`.
 *
 * This must be responsive, not a fixed pixel value: React Flow's `fitView`
 * computes the zoom level needed to fit every node in the container, and a
 * short fixed-height container forces that computed zoom below the library's
 * default `minZoom` (0.5) for deep/branching graphs, which clips the graph
 * top and bottom even after fitting — see `pipeline-graph-view.tsx`'s
 * `minZoom` override, which only helps if the container also has enough
 * headroom to be worth zooming into. `clamp()` keeps the container from
 * collapsing too short on small viewports while letting it grow with the
 * window on larger ones, without needing layout JS.
 */
export const PIPELINE_GRAPH_HEIGHT = "clamp(420px, 55vh, 720px)";

/**
 * Inset applied to each viewport edge for the pipeline graph's expanded
 * (fullscreen-ish) overlay state — see the "Expand"/"Collapse" toggle in
 * `execution-overview.tsx`. CSS `inset` shorthand order is
 * `<top/bottom> <left/right>`. Deliberately not `0` (true edge-to-edge):
 * a small margin keeps the graph from feeling claustrophobic and from
 * clipping against browser chrome (address bar, etc.) on some viewports,
 * while still giving deep/branching graphs far more room than
 * `PIPELINE_GRAPH_HEIGHT` allows.
 */
export const PIPELINE_GRAPH_EXPANDED_INSET = "5vh 4vw";
