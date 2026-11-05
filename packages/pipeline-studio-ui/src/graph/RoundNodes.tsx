import type { CSSProperties, ReactNode } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { fonts } from "@scarn/design-tokens";
import {
  ROUND_HANDLES,
  type RoundLaneData,
  type RoundMemberData,
} from "./automation-round-layout";
import type { RoundNode } from "./automation-round-types";
import { EMPTY_NODE_DECORATION } from "./graph-decoration";
import { GraphIcon, type GraphIconName } from "./graph-icons";
import {
  GraphNode,
  hiddenHandle,
  selectionShadow,
  truncate,
  type GraphNodeType,
} from "./GraphNode";
import { palette, tint } from "./graph-palette";
import type { StudioNodeData } from "./studio-graph-types";

type LaneNodeType = Node<RoundLaneData>;
type MemberNodeType = Node<RoundMemberData>;

/**
 * Anchors for round edges: forward edges leave on the right and enter on the
 * left, back edges leave and enter from the top.
 */
function RoundHandles() {
  return (
    <>
      <Handle
        id={ROUND_HANDLES.forwardTarget}
        type="target"
        position={Position.Left}
        isConnectable={false}
        style={hiddenHandle}
      />
      <Handle
        id={ROUND_HANDLES.backTarget}
        type="target"
        position={Position.Top}
        isConnectable={false}
        style={hiddenHandle}
      />
      <Handle
        id={ROUND_HANDLES.forwardSource}
        type="source"
        position={Position.Right}
        isConnectable={false}
        style={hiddenHandle}
      />
      <Handle
        id={ROUND_HANDLES.backSource}
        type="source"
        position={Position.Top}
        isConnectable={false}
        style={hiddenHandle}
      />
    </>
  );
}

/** A swimlane band behind the nodes, titled in its top-left corner. */
export function LaneNode({ data }: NodeProps<LaneNodeType>) {
  if (data.lane === null) {
    return <div style={{ width: data.width, height: data.height }} />;
  }
  return (
    <div
      data-lane={data.lane}
      style={{
        width: data.width,
        height: data.height,
        boxSizing: "border-box",
        border: `1px dashed ${palette.border}`,
        borderRadius: 10,
        background: tint(palette.bgElev, 45),
        padding: "6px 12px",
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        color: palette.textDim,
      }}
    >
      {data.label}
    </div>
  );
}

/** The pipeline graph's card data for a step, pipeline or attach node. */
function cardData(node: RoundNode): StudioNodeData {
  const base = {
    label: node.label,
    issues: [],
    shape: { kind: "none" as const },
  };
  switch (node.kind) {
    case "step":
      return { ...base, kind: "step", stepKey: node.stepKey };
    case "pipeline":
      return {
        ...base,
        kind: "pipeline",
        targetKey: node.pipelineKey,
        resolved: node.resolved,
      };
    case "attach":
      return {
        ...base,
        kind: "action",
        actionKind: "attach",
        targetKey: node.automationKey,
      };
    default:
      return { ...base, kind: "step" };
  }
}

/** Step, pipeline and attach nodes: the pipeline graph's card, with round handles. */
export function RoundCardNode(props: NodeProps<MemberNodeType>) {
  const { data } = props;
  const cardProps = {
    ...props,
    data: { ...cardData(data.node), decoration: EMPTY_NODE_DECORATION },
  } as NodeProps<GraphNodeType>;
  return (
    <div
      style={{ position: "relative", width: data.width, height: data.height }}
    >
      <GraphNode {...cardProps} />
      <RoundHandles />
    </div>
  );
}

function Pill({
  data,
  selected,
  icon,
  color,
  caption,
  dashed = false,
  children,
}: {
  data: RoundMemberData;
  selected: boolean;
  icon: GraphIconName;
  color: string;
  caption: string;
  dashed?: boolean;
  children?: ReactNode;
}) {
  const style: CSSProperties = {
    width: data.width,
    height: data.height,
    boxSizing: "border-box",
    position: "relative",
    borderRadius: dashed ? 8 : data.height / 2,
    border: `1px ${dashed ? "dashed" : "solid"} ${tint(color, 55)}`,
    background: `linear-gradient(${tint(color, 10)}, ${tint(color, 10)}), ${palette.bgElev}`,
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "0 14px 0 8px",
    boxShadow: selectionShadow(selected),
  };
  return (
    <div
      className="pipeline-graph-node"
      data-kind={data.kind}
      title={data.node.label}
      style={style}
    >
      <div
        style={{
          flexShrink: 0,
          width: 26,
          height: 26,
          borderRadius: "50%",
          background: tint(color, 18),
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <GraphIcon name={icon} size={16} color={color} />
      </div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div
          style={{
            ...truncate,
            fontWeight: 600,
            fontSize: 13,
            lineHeight: "16px",
            color: palette.text,
            fontFamily: data.kind === "junction" ? fonts.mono : undefined,
          }}
        >
          {data.node.label}
        </div>
        <div
          style={{
            ...truncate,
            fontSize: 10,
            lineHeight: "12px",
            fontWeight: 600,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            color,
          }}
        >
          {caption}
        </div>
      </div>
      {children}
      <RoundHandles />
    </div>
  );
}

/** One rule with its event: the automation's entry point. */
export function JunctionNode({ data, selected }: NodeProps<MemberNodeType>) {
  const node = data.node;
  const rule =
    node.kind === "junction" ? `Rule ${String(node.ruleIndex + 1)}` : "Rule";
  const fork =
    node.kind === "junction" && node.match === "all" ? " · all routes" : "";
  return (
    <Pill
      data={data}
      selected={selected}
      icon="event"
      color={palette.attention}
      caption={`${rule}${fork}`}
    />
  );
}

/** A person who handles children with a label no route picks up. */
export function PersonNode({ data, selected }: NodeProps<MemberNodeType>) {
  const node = data.node;
  return (
    <Pill
      data={data}
      selected={selected}
      icon="wait"
      color={palette.attention}
      caption={node.kind === "person" ? node.childLabel : ""}
      dashed
    />
  );
}

/** The automation's own work item, closed. */
export function EndNode({ data, selected }: NodeProps<MemberNodeType>) {
  return (
    <Pill
      data={data}
      selected={selected}
      icon="succeed"
      color={palette.success}
      caption="Work item"
    />
  );
}
