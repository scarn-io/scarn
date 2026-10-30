import type { Edge, Node } from "@xyflow/react";
import type { PipelineNode } from "@scarn/sdk/contracts/pipeline-document";

// `Node`/`Edge` are imported `type`-only (see the top-level comment in
// `translate-spec-to-graph.ts`), so this file — and everything that only
// imports types from it — never pulls the real `@xyflow/react` runtime (React
// component tree, `@xyflow/system`, `classcat`, ...) into a non-browser bundle
// such as `@scarn/worker`'s local studio server.

/**
 * One problem shown in the studio. Pipeline issues come from
 * `validatePipeline` (`path` is the JSON pointer into the document); step
 * issues come from the SDK's step checks and have no `pipelineKey`.
 */
export type StudioIssue = {
  code: string;
  severity: "error" | "warning" | "info";
  message: string;
  hint?: string;
  /** RFC 6901 pointer into the pipeline document, when pipeline-scoped. */
  path?: string;
  pipelineKey?: string;
  /** The node the issue is about, derived from `path`. */
  nodeId?: string;
};

/** One field of a step's input or result schema, as shown on its node. */
export type StudioSchemaField = {
  name: string;
  type: string;
  required: boolean;
};

/**
 * A node's step-derived shape. `"step"` when the node's step key resolves in
 * the step catalog passed to `translateSpecToGraph`; `"none"` otherwise
 * (wait/succeed/fail nodes, or a step that wasn't found) — chosen over
 * fabricating empty arrays, which would read as a real zero-field step.
 */
export type StudioNodeShape =
  | {
      kind: "step";
      inputFields: StudioSchemaField[];
      resultFields: StudioSchemaField[];
      resultSchemaJson: Record<string, unknown>;
      errors: string[];
    }
  | { kind: "none" };

/**
 * A document node's kind, or `"start"` for the synthetic entry node the
 * `start` transition leaves from (id `START_NODE_ID`).
 */
export type StudioNodeKind = PipelineNode["kind"] | "start";

/** Per-node data the designer renders inline next to the node itself. */
export type StudioNodeData = {
  /** The node's `title`, falling back to its id. */
  label: string;
  kind: StudioNodeKind;
  stepKey?: string;
  /** `for` on a wait node. */
  waitFor?: string;
  /** How a step or wait node picks its routes: the first match, or every match as a lane (a fork). */
  match?: "first" | "all";
  /** On a merge node: the titles of the nodes whose `partial` routes it waits for, in edge order. */
  mergeWaitsFor?: string[];
  issues: StudioIssue[];
  shape: StudioNodeShape;
};

/** How the engine leaves the source node along an edge. */
export type StudioEdgeKind = "start" | "route" | "otherwise" | "catch";

export type StudioPoint = { x: number; y: number };

/**
 * How an edge is drawn, computed by the layout. A `flow` edge runs down
 * through dagre's waypoints, `label` being the centre of the slot dagre
 * reserved for its label (null when it has none). A `loop` edge (a back edge
 * or self loop) leaves the source's right side, runs up a vertical lane at
 * `laneX` clear of every node and label it passes, and enters the target's
 * right side; its label sits on that lane.
 */
export type StudioEdgeRoute =
  | { kind: "flow"; waypoints: StudioPoint[]; label: StudioPoint | null }
  | { kind: "loop"; laneX: number };

export type StudioEdgeData = {
  kind: StudioEdgeKind;
  /** Position in the source node's `next.routes` or `catch` list; 0 for `otherwise`. */
  index: number;
  /** `each` opens a lane group; `partial` arrives at the merge that closes it. */
  lane: "each" | "partial" | null;
  /**
   * The route's 1-based check order on a `first` node with more than one
   * route; null for `all` routes (unordered), `otherwise`, `start`, `catch`
   * and lone routes.
   */
  order: number | null;
  issues: StudioIssue[];
  /** Set by the layout; absent on an edge that was never laid out. */
  route?: StudioEdgeRoute;
};

export type StudioNode = Node<StudioNodeData>;
export type StudioEdge = Edge<StudioEdgeData>;

/** One pipeline's translated, laid-out graph. */
export type PipelineGraphSnapshot = {
  key: string;
  name: string;
  nodes: StudioNode[];
  edges: StudioEdge[];
};

/** A pipeline document file that couldn't be read or parsed. */
export type BrokenPipeline = {
  readonly key: string;
  readonly message: string;
};

/**
 * The SSE stream's payload shape. One entry per pipeline document found in
 * `.scarn/pipeline-builder`; the client picks which one to render (see
 * `App.tsx`).
 *
 * `validationIssues` carries the FULL issue list, including step issues with
 * no node to attach to, so they still reach the UI. See
 * `compute-studio-snapshot.ts`.
 */
export type StudioSnapshot =
  | {
      status: "ok";
      pipelines: PipelineGraphSnapshot[];
      brokenPipelines: readonly BrokenPipeline[];
      validationIssues: StudioIssue[];
      collectedAt: string;
    }
  | {
      status: "error";
      message: string;
      collectedAt: string;
    };
