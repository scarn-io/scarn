// Pure automation document → React Flow `{nodes, edges}` translation for the
// read-only graph of one automation: event → rule → route target. No I/O, no
// React; shares `layoutGraph` with `translateDocumentToGraph`.
//
// The graph shows only the wiring the document declares. It never links an
// `attach` target to the automation it names, or two targets that share a key.
import {
  automationDocumentSchema,
  type AutomationDocument,
  type AutomationEvent,
  type AutomationRule,
  type AutomationTargetJson,
} from "@scarn/sdk/contracts/automation-document";
import { describeCondition } from "./describe-transition";
import { layoutGraph } from "./graph-layout";
import type {
  StudioEdge,
  StudioEdgeKind,
  StudioNode,
  StudioNodeData,
} from "./studio-graph-types";

export type AutomationGraphInput = {
  key: string;
  /** The latest version's document. */
  document: unknown;
};

/** An automation whose latest document doesn't parse as an automation document. */
export class AutomationGraphError extends Error {
  readonly automationKey: string;

  constructor(automationKey: string, detail: string) {
    super(`Automation "${automationKey}" has an invalid document: ${detail}`);
    this.name = "AutomationGraphError";
    this.automationKey = automationKey;
  }
}

type Graph = { nodes: StudioNode[]; edges: StudioEdge[] };

function parse({ key, document }: AutomationGraphInput): AutomationDocument {
  const result = automationDocumentSchema.safeParse(document);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const detail =
    issue === undefined
      ? "unknown error"
      : issue.path.length > 0
        ? `${issue.path.map(String).join(".")}: ${issue.message}`
        : issue.message;
  throw new AutomationGraphError(key, detail);
}

function node(
  id: string,
  data: Omit<StudioNodeData, "issues" | "shape">,
): StudioNode {
  return {
    id,
    position: { x: 0, y: 0 },
    data: { ...data, issues: [], shape: { kind: "none" } },
  };
}

function edge(
  source: string,
  target: string,
  kind: StudioEdgeKind,
  index: number,
  label: string | undefined,
  order: number | null = null,
): StudioEdge {
  return {
    id: `${source}:${kind}:${String(index)}->${target}`,
    source,
    target,
    label,
    data: { kind, index, lane: null, order, issues: [] },
  };
}

function targetNode(
  id: string,
  target: AutomationTargetJson,
  pipelineNames: ReadonlyMap<string, string>,
): StudioNode {
  switch (target.kind) {
    case "pipeline": {
      const name = pipelineNames.get(target.to);
      return node(id, {
        label: name ?? target.to,
        kind: "pipeline",
        targetKey: target.to,
        subject: target.on,
        resolved: name !== undefined,
      });
    }
    case "step":
      return node(id, {
        label: target.to,
        kind: "action",
        actionKind: "step",
        targetKey: target.to,
        subject: target.on,
      });
    case "attach":
      return node(id, {
        label: target.automation,
        kind: "action",
        actionKind: "attach",
        targetKey: target.automation,
      });
    case "skip":
      return node(id, { label: "Skip", kind: "action", actionKind: "skip" });
  }
}

const eventId = (event: AutomationEvent) => `event:${event}`;

function addRule(
  graph: Graph,
  rule: AutomationRule,
  ruleIndex: number,
  pipelineNames: ReadonlyMap<string, string>,
): void {
  const ruleId = `rule:${String(ruleIndex)}`;
  const match = rule.next.match ?? "first";
  graph.nodes.push(
    node(ruleId, {
      label: `Rule ${String(ruleIndex + 1)}`,
      kind: "rule",
      event: rule.event,
      ruleIndex,
      match,
    }),
  );
  graph.edges.push(
    edge(eventId(rule.event), ruleId, "start", ruleIndex, undefined),
  );

  const ordered = match === "first" && rule.next.routes.length > 1;
  rule.next.routes.forEach((route, routeIndex) => {
    const targetId = `target:${String(ruleIndex)}:${String(routeIndex)}`;
    graph.nodes.push(targetNode(targetId, route, pipelineNames));
    graph.edges.push(
      edge(
        ruleId,
        targetId,
        "route",
        routeIndex,
        route.when === undefined ? undefined : describeCondition(route.when),
        ordered ? routeIndex + 1 : null,
      ),
    );
  });

  if (rule.next.otherwise !== undefined) {
    const targetId = `target:${String(ruleIndex)}:otherwise`;
    graph.nodes.push(targetNode(targetId, rule.next.otherwise, pipelineNames));
    graph.edges.push(edge(ruleId, targetId, "otherwise", 0, "otherwise"));
  }
}

/**
 * Translates one automation's latest document into a laid-out graph: one
 * event node per distinct event it reacts to, a `start` edge from that event
 * to each rule node reacting to it, and one target node per route and
 * `otherwise` (`route` edges labelled with their `when`, ordered on a `first`
 * rule with several routes; an `otherwise` edge).
 *
 * A document with no rules gives an empty graph. Throws
 * `AutomationGraphError` when the document fails to parse.
 */
export function translateAutomationToGraph(
  automation: AutomationGraphInput,
  pipelineNames: ReadonlyMap<string, string>,
): Graph {
  const document = parse(automation);
  const graph: Graph = { nodes: [], edges: [] };

  const events: AutomationEvent[] = [];
  for (const rule of document.rules) {
    if (!events.includes(rule.event)) events.push(rule.event);
  }
  for (const event of events) {
    graph.nodes.push(
      node(eventId(event), { label: event, kind: "event", event }),
    );
  }

  document.rules.forEach((rule, ruleIndex) => {
    addRule(graph, rule, ruleIndex, pipelineNames);
  });
  return layoutGraph(graph.nodes, graph.edges);
}
