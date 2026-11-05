// Pure swimlane layout of an automation round (`buildAutomationRound`): one
// lane per work item the round touches, columns left to right along the
// round, and back edges ("next round") in channels above the lanes.
//
// `@xyflow/react` is imported type-only, so the package root stays free of
// the React Flow runtime.
import type { Edge, Node } from "@xyflow/react";
import { findBackEdges, roundColumns } from "./automation-round-columns";
import type {
  AutomationRoundModel,
  RoundEdge,
  RoundNode,
  RoundNodeKind,
} from "./automation-round-types";
import { nodeLayoutSize, orderedEdgeLabel } from "./studio-graph-visuals";

export const ROUND_COLUMN_WIDTH = 400;
export const ROUND_ROW_HEIGHT = 72;
export const ROUND_CHANNEL_GAP = 24;
const LANE_PAD_TOP = 34;
const LANE_PAD_BOTTOM = 18;
const LANE_GAP = 16;
const LANE_INSET_X = 40;
const LANE_EXTRA_WIDTH = 20;
const ROW_GAP = 16;
const BACK_EDGE_SPREAD = 18;

export type RoundLane = "automation" | "workItem" | "child";

export const LANE_ORDER: readonly RoundLane[] = [
  "automation",
  "workItem",
  "child",
];

export const LANE_TITLE: Record<RoundLane, string> = {
  automation: "Automation · events & rules",
  workItem: "This work item",
  child: "Child work items",
};

/** Node handle ids every round node carries: forward edges run right to left, back edges leave and enter from the top. */
export const ROUND_HANDLES = {
  forwardSource: "r-s",
  forwardTarget: "l-t",
  backSource: "t-s",
  backTarget: "t-t",
} as const;

/** A lane band behind the nodes; `lane: null` is the empty band the back-edge channels run in. */
export type RoundLaneData = {
  kind: "lane";
  lane: RoundLane | null;
  label: string;
  width: number;
  height: number;
};

export type RoundMemberData = {
  kind: RoundNodeKind;
  node: RoundNode;
  lane: RoundLane;
  column: number;
  /** Position among the nodes sharing its lane and column, in document order. */
  row: number;
  width: number;
  height: number;
};

export type RoundLayoutNodeData = RoundLaneData | RoundMemberData;
export type RoundLayoutNode = Node<RoundLayoutNodeData>;

/** `route`: a declared route; `declared` / `engine`: a soft link and where it comes from. */
export type RoundEdgeTone = "route" | "declared" | "engine";

export type RoundEdgeData = {
  edge: RoundEdge;
  tone: RoundEdgeTone;
  path: "forward" | "back";
  /** Forward edges: which end the label sits next to. */
  labelAt?: "source" | "target";
  /** Back edges: the y of their channel above the lanes, and x offsets so edges sharing a node don't overlap. */
  channelY?: number;
  exitDx?: number;
  enterDx?: number;
};

export type RoundLayoutEdge = Edge<RoundEdgeData>;

export type AutomationRoundLayout = {
  nodes: RoundLayoutNode[];
  edges: RoundLayoutEdge[];
};

/** Which lane a node sits in: the work item its target runs `on`, or the automation itself. */
export function laneOf(node: RoundNode): RoundLane {
  switch (node.kind) {
    case "step":
    case "pipeline":
      return node.on === "child" ? "child" : "workItem";
    case "person":
      return "child";
    case "end":
      return "workItem";
    case "junction":
    case "attach":
      return "automation";
  }
}

const JUNCTION_SIZE = { width: 200, height: 44 };
const PERSON_SIZE = { width: 200, height: 56 };
const END_SIZE = { width: 160, height: 40 };

/** The size a round node is drawn at; step, pipeline and attach nodes reuse the pipeline graph's card. */
export function roundNodeSize(node: RoundNode): {
  width: number;
  height: number;
} {
  switch (node.kind) {
    case "junction":
      return { ...JUNCTION_SIZE };
    case "person":
      return { ...PERSON_SIZE };
    case "end":
      return { ...END_SIZE };
    case "step":
    case "pipeline":
    case "attach":
      return nodeLayoutSize({ kind: "step" });
  }
}

function edgeTone(edge: RoundEdge): RoundEdgeTone {
  return edge.kind === "route" ? "route" : edge.provenance;
}

function edgeText(edge: RoundEdge, back: boolean): string | undefined {
  const label =
    edge.kind === "route"
      ? orderedEdgeLabel(edge.label, edge.order)
      : edge.label;
  if (!back || (edge.kind === "soft" && edge.provenance === "engine")) {
    return label;
  }
  return label ? `↻ next round · ${label}` : "↻ next round";
}

type Cells = Map<string, string[]>;

const cellKey = (lane: RoundLane, column: number) =>
  `${lane}:${String(column)}`;

function placeLanes(lanes: readonly RoundLane[], cells: Cells) {
  const rowsIn = (lane: RoundLane) =>
    Math.max(
      1,
      ...[...cells.entries()]
        .filter(([key]) => key.startsWith(`${lane}:`))
        .map(([, ids]) => ids.length),
    );
  const placed = new Map<RoundLane, { top: number; height: number }>();
  let y = 0;
  for (const lane of lanes) {
    const height =
      LANE_PAD_TOP + rowsIn(lane) * ROUND_ROW_HEIGHT + LANE_PAD_BOTTOM;
    placed.set(lane, { top: y, height });
    y += height + LANE_GAP;
  }
  return placed;
}

function laneNode(id: string, data: RoundLaneData, y: number): RoundLayoutNode {
  return {
    id,
    type: "lane",
    position: { x: -LANE_INSET_X, y },
    data,
    draggable: false,
    selectable: false,
    focusable: false,
    zIndex: -1,
    width: data.width,
    height: data.height,
  };
}

/** Back edges sorted shortest loop first, so shorter loops get the lower channels. */
function sortBackEdges(
  edges: readonly RoundEdge[],
  column: ReadonlyMap<string, number>,
): RoundEdge[] {
  const span = (edge: RoundEdge) =>
    Math.abs((column.get(edge.source) ?? 0) - (column.get(edge.target) ?? 0));
  return [...edges].sort((a, b) => span(a) - span(b));
}

function backEdgeData(
  edge: RoundEdge,
  backEdges: readonly RoundEdge[],
): Pick<RoundEdgeData, "channelY" | "exitDx" | "enterDx"> {
  const atTop = (node: string) =>
    backEdges
      .filter((other) => other.source === node || other.target === node)
      .map((other) => other.id);
  const spread = (ids: readonly string[]) =>
    (ids.indexOf(edge.id) - (ids.length - 1) / 2) * BACK_EDGE_SPREAD;
  return {
    channelY: -ROUND_CHANNEL_GAP * (backEdges.indexOf(edge) + 1),
    exitDx: spread(atTop(edge.source)),
    enterDx: spread(atTop(edge.target)),
  };
}

/**
 * Lays an automation round out in swimlanes. Lanes come in `LANE_ORDER`,
 * empty ones dropped; a node's column is the longest path to it once back
 * edges are set aside, and nodes sharing a lane and column stack in document
 * order. Forward edges are labelled next to the target when their source
 * fans out to several targets, else next to the source. Each back edge gets
 * its own channel above the lanes, shorter loops lower.
 */
export function layoutAutomationRound(
  model: AutomationRoundModel,
): AutomationRoundLayout {
  const back = findBackEdges(model.nodes, model.edges);
  const forward = model.edges.filter((edge) => !back.has(edge.id));
  const column = roundColumns(model.nodes, forward);

  const laneById = new Map(model.nodes.map((node) => [node.id, laneOf(node)]));
  const lanes = LANE_ORDER.filter((lane) =>
    model.nodes.some((node) => laneById.get(node.id) === lane),
  );
  const cells: Cells = new Map();
  for (const node of model.nodes) {
    const key = cellKey(laneOf(node), column.get(node.id) ?? 0);
    cells.set(key, [...(cells.get(key) ?? []), node.id]);
  }
  const laneBox = placeLanes(lanes, cells);
  const maxColumn = Math.max(0, ...column.values());
  const laneWidth = (maxColumn + 1) * ROUND_COLUMN_WIDTH + LANE_EXTRA_WIDTH;

  const laneNodes = lanes.map((lane) => {
    const box = laneBox.get(lane) ?? { top: 0, height: 0 };
    return laneNode(
      `lane:${lane}`,
      {
        kind: "lane",
        lane,
        label: LANE_TITLE[lane],
        width: laneWidth,
        height: box.height,
      },
      box.top,
    );
  });

  const members = model.nodes.map((node): RoundLayoutNode => {
    const lane = laneOf(node);
    const col = column.get(node.id) ?? 0;
    const row = cells.get(cellKey(lane, col))?.indexOf(node.id) ?? 0;
    const size = roundNodeSize(node);
    const rowTop =
      (laneBox.get(lane)?.top ?? 0) + LANE_PAD_TOP + row * ROUND_ROW_HEIGHT;
    return {
      id: node.id,
      type: node.kind,
      position: {
        x: col * ROUND_COLUMN_WIDTH,
        y: rowTop + (ROUND_ROW_HEIGHT - ROW_GAP - size.height) / 2,
      },
      data: { kind: node.kind, node, lane, column: col, row, ...size },
      width: size.width,
      height: size.height,
    };
  });

  const backEdges = sortBackEdges(
    model.edges.filter((edge) => back.has(edge.id)),
    column,
  );
  const fanOut = (id: string) =>
    forward.filter((edge) => edge.source === id).length;

  const edges = model.edges.map((edge): RoundLayoutEdge => {
    const isBack = back.has(edge.id);
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      sourceHandle: isBack
        ? ROUND_HANDLES.backSource
        : ROUND_HANDLES.forwardSource,
      targetHandle: isBack
        ? ROUND_HANDLES.backTarget
        : ROUND_HANDLES.forwardTarget,
      type: "roundEdge",
      label: edgeText(edge, isBack),
      data: isBack
        ? {
            edge,
            tone: edgeTone(edge),
            path: "back",
            ...backEdgeData(edge, backEdges),
          }
        : {
            edge,
            tone: edgeTone(edge),
            path: "forward",
            labelAt: fanOut(edge.source) > 1 ? "target" : "source",
          },
    };
  });

  const channelHeight = ROUND_CHANNEL_GAP * (backEdges.length + 1);
  const channels =
    backEdges.length > 0
      ? [
          laneNode(
            "lane:channels",
            {
              kind: "lane",
              lane: null,
              label: "",
              width: laneWidth,
              height: channelHeight,
            },
            -channelHeight,
          ),
        ]
      : [];

  return { nodes: [...channels, ...laneNodes, ...members], edges };
}
