// Types and node ids of the automation round model (`buildAutomationRound`).
import type {
  AutomationEvent,
  AutomationNext,
  AutomationSubject,
} from "@scarn/sdk/contracts/automation-document";

type AutomationMatchMode = NonNullable<AutomationNext["match"]>;

/** One rule, shown with its event as one node. Two rules on one event stay apart. */
export type RoundJunctionNode = {
  id: string;
  kind: "junction";
  label: AutomationEvent;
  event: AutomationEvent;
  ruleIndex: number;
  match: AutomationMatchMode;
};

export type RoundStepNode = {
  id: string;
  kind: "step";
  label: string;
  stepKey: string;
  on: AutomationSubject;
};

export type RoundPipelineNode = {
  id: string;
  kind: "pipeline";
  /** The pipeline's name, or its key when the project has no such pipeline. */
  label: string;
  pipelineKey: string;
  on: AutomationSubject;
  resolved: boolean;
};

export type RoundAttachNode = {
  id: string;
  kind: "attach";
  label: string;
  automationKey: string;
};

/** A person who handles children carrying `childLabel`, which no route picks up. */
export type RoundPersonNode = {
  id: string;
  kind: "person";
  label: "A person";
  childLabel: string;
};

/** The automation's own work item, closed. */
export type RoundEndNode = {
  id: string;
  kind: "end";
  label: "Closed";
};

export type RoundNode =
  | RoundJunctionNode
  | RoundStepNode
  | RoundPipelineNode
  | RoundAttachNode
  | RoundPersonNode
  | RoundEndNode;

export type RoundNodeKind = RoundNode["kind"];

/** An edge the document declares, from a junction to a target. The engine follows it. */
export type RoundRouteEdge = {
  id: string;
  kind: "route";
  source: string;
  target: string;
  /** The matched child label, else the described `when`, "otherwise", or none. */
  label: string | undefined;
  /** 1-based route order on a `first` rule with several routes, else null. */
  order: number | null;
  otherwise: boolean;
  /** The child label the route matches, when its `when` is a plain `contains` on `event.child.labels`. */
  matchedLabel: string | null;
};

/** `declared`: read from a step's grants. `engine`: the engine does it. */
export type SoftLinkProvenance = "declared" | "engine";

/** An edge the agent, a person or the engine may cause. */
export type RoundSoftEdge = {
  id: string;
  kind: "soft";
  source: string;
  target: string;
  label: string;
  provenance: SoftLinkProvenance;
  /** The labels a `create` grant lets the step set, or the child label a person handles. */
  labels?: readonly string[];
};

export type RoundEdge = RoundRouteEdge | RoundSoftEdge;
export type RoundEdgeKind = RoundEdge["kind"];

export type AutomationRoundModel = {
  automationKey: string;
  /** Junctions in rule order, then targets in document order, then person and end nodes. */
  nodes: RoundNode[];
  edges: RoundEdge[];
};

export const END_NODE_ID = "end:closed";

export const junctionNodeId = (ruleIndex: number) =>
  `junction:${String(ruleIndex)}`;
export const stepNodeId = (key: string, on: AutomationSubject) =>
  `step:${key}@${on}`;
export const pipelineNodeId = (key: string, on: AutomationSubject) =>
  `pipeline:${key}@${on}`;
export const attachNodeId = (automation: string) => `attach:${automation}`;
export const personNodeId = (childLabel: string) => `person:${childLabel}`;
