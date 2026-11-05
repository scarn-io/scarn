// Pure model of one automation drawn as one round: a junction per rule (its
// event and rule as one node), the targets its routes start, and the soft
// links its steps' grants say an agent may cause. No layout, no React.
//
// Soft links only join targets and events of this automation: `attach`
// targets aren't followed, pipeline targets draw none, and a step key with no
// grants draws its target with no links.
import type {
  AutomationDocument,
  AutomationEvent,
  AutomationRoute,
  AutomationTargetJson,
} from "@scarn/sdk/contracts/automation-document";
import type { Grant } from "@scarn/sdk/definitions/steps";
import {
  parseAutomationDocument,
  type AutomationGraphInput,
} from "./automation-document-parse";
import {
  attachNodeId,
  END_NODE_ID,
  junctionNodeId,
  personNodeId,
  pipelineNodeId,
  stepNodeId,
  type AutomationRoundModel,
  type RoundEdge,
  type RoundNode,
  type RoundSoftEdge,
  type RoundStepNode,
} from "./automation-round-types";
import { describeCondition } from "./describe-transition";

const CHILD_LABELS_PATH = "event.child.labels";

/** The label a route's `when` requires, when it's a plain `contains` on the child's labels. */
export function routeMatchedLabel(
  when: AutomationRoute["when"],
): string | null {
  if (
    when?.op === "contains" &&
    when.path === CHILD_LABELS_PATH &&
    typeof when.value === "string"
  ) {
    return when.value;
  }
  return null;
}

type Builder = {
  nodes: Map<string, RoundNode>;
  edges: RoundEdge[];
};

function addNode(builder: Builder, node: RoundNode): void {
  if (!builder.nodes.has(node.id)) builder.nodes.set(node.id, node);
}

function targetNode(
  target: Exclude<AutomationTargetJson, { kind: "skip" }>,
  pipelineNames: ReadonlyMap<string, string>,
): RoundNode {
  switch (target.kind) {
    case "step":
      return {
        id: stepNodeId(target.to, target.on),
        kind: "step",
        label: target.to,
        stepKey: target.to,
        on: target.on,
      };
    case "pipeline": {
      const name = pipelineNames.get(target.to);
      return {
        id: pipelineNodeId(target.to, target.on),
        kind: "pipeline",
        label: name ?? target.to,
        pipelineKey: target.to,
        on: target.on,
        resolved: name !== undefined,
      };
    }
    case "attach":
      return {
        id: attachNodeId(target.automation),
        kind: "attach",
        label: target.automation,
        automationKey: target.automation,
      };
  }
}

function addRoutes(
  builder: Builder,
  document: AutomationDocument,
  pipelineNames: ReadonlyMap<string, string>,
): void {
  document.rules.forEach((rule, ruleIndex) => {
    const junctionId = junctionNodeId(ruleIndex);
    const match = rule.next.match ?? "first";
    addNode(builder, {
      id: junctionId,
      kind: "junction",
      label: rule.event,
      event: rule.event,
      ruleIndex,
      match,
    });

    const ordered = match === "first" && rule.next.routes.length > 1;
    const targets: {
      target: AutomationTargetJson;
      when: AutomationRoute["when"];
      suffix: string;
      order: number | null;
    }[] = rule.next.routes.map((route, routeIndex) => ({
      target: route,
      when: route.when,
      suffix: String(routeIndex),
      order: ordered ? routeIndex + 1 : null,
    }));
    if (rule.next.otherwise !== undefined) {
      targets.push({
        target: rule.next.otherwise,
        when: undefined,
        suffix: "otherwise",
        order: null,
      });
    }

    for (const { target, when, suffix, order } of targets) {
      if (target.kind === "skip") continue;
      const node = targetNode(target, pipelineNames);
      addNode(builder, node);
      const otherwise = suffix === "otherwise";
      const matchedLabel = otherwise ? null : routeMatchedLabel(when);
      builder.edges.push({
        id: `route:${String(ruleIndex)}:${suffix}`,
        kind: "route",
        source: junctionId,
        target: node.id,
        label: otherwise
          ? "otherwise"
          : (matchedLabel ??
            (when === undefined ? undefined : describeCondition(when))),
        order,
        otherwise,
        matchedLabel,
      });
    }
  });
}

function junctionsOf(
  document: AutomationDocument,
  ...events: AutomationEvent[]
): string[] {
  return document.rules.flatMap((rule, ruleIndex) =>
    events.includes(rule.event) ? [junctionNodeId(ruleIndex)] : [],
  );
}

function routedChildLabels(document: AutomationDocument): Set<string> {
  return new Set(
    document.rules
      .filter((rule) => rule.event === "child.ready")
      .flatMap((rule) =>
        rule.next.routes
          .filter((route) => route.kind !== "skip")
          .map((route) => routeMatchedLabel(route.when)),
      )
      .filter((label): label is string => label !== null),
  );
}

type SoftLink = Omit<RoundSoftEdge, "id" | "kind" | "target">;

function addSoftLinks(
  builder: Builder,
  link: SoftLink,
  targets: readonly string[],
): void {
  for (const target of targets) {
    builder.edges.push({
      id: `soft:${link.source}->${target}`,
      kind: "soft",
      target,
      ...link,
    });
  }
}

function addStepSoftLinks(
  builder: Builder,
  document: AutomationDocument,
  step: RoundStepNode,
  grants: readonly Grant[],
): string[] {
  const createdLabels: string[] = [];
  const source = step.id;
  for (const grant of grants) {
    if (grant.action === "create" && step.on === "workItem") {
      createdLabels.push(...grant.labels);
      addSoftLinks(
        builder,
        {
          source,
          label: "creates children",
          provenance: "declared",
          labels: grant.labels,
        },
        junctionsOf(document, "child.ready", "child.created"),
      );
    }
    if (grant.action !== "close") continue;
    if (grant.scope === "self" && step.on === "child") {
      addSoftLinks(
        builder,
        { source, label: "closes child", provenance: "declared" },
        junctionsOf(document, "child.closed"),
      );
    } else if (grant.scope === "self" && step.on === "workItem") {
      addNode(builder, { id: END_NODE_ID, kind: "end", label: "Closed" });
      addSoftLinks(
        builder,
        { source, label: "closes work item", provenance: "declared" },
        [END_NODE_ID],
      );
    } else if (grant.scope === "children" && step.on === "workItem") {
      addSoftLinks(
        builder,
        { source, label: "closes children", provenance: "declared" },
        junctionsOf(document, "child.closed"),
      );
    }
  }
  return createdLabels;
}

function addPeople(
  builder: Builder,
  document: AutomationDocument,
  createdLabels: readonly string[],
): void {
  const readyJunctions = junctionsOf(document, "child.ready");
  if (readyJunctions.length === 0) return;
  const routed = routedChildLabels(document);
  const closedJunctions = junctionsOf(document, "child.closed");
  for (const childLabel of new Set(createdLabels)) {
    if (routed.has(childLabel)) continue;
    const id = personNodeId(childLabel);
    addNode(builder, { id, kind: "person", label: "A person", childLabel });
    for (const junction of readyJunctions) {
      builder.edges.push({
        id: `soft:${junction}->${id}`,
        kind: "soft",
        source: junction,
        target: id,
        label: childLabel,
        provenance: "declared",
        labels: [childLabel],
      });
    }
    addSoftLinks(
      builder,
      { source: id, label: "closes by hand", provenance: "declared" },
      closedJunctions,
    );
  }
}

function addEngineLinks(builder: Builder, document: AutomationDocument): void {
  const readyJunctions = junctionsOf(document, "child.ready");
  for (const source of junctionsOf(document, "child.closed")) {
    addSoftLinks(
      builder,
      { source, label: "unblocks siblings", provenance: "engine" },
      readyJunctions,
    );
  }
}

/**
 * Builds the round model of one automation's latest document: one junction
 * per rule, one node per distinct target (`skip` dropped), a `route` edge per
 * route and `otherwise`, and `soft` edges read from `stepGrants` (keyed by
 * step key, from the latest active definition of each).
 *
 * Throws `AutomationGraphError` when the document fails to parse.
 */
export function buildAutomationRound(
  automation: AutomationGraphInput,
  stepGrants: ReadonlyMap<string, readonly Grant[]>,
  pipelineNames: ReadonlyMap<string, string>,
): AutomationRoundModel {
  const document = parseAutomationDocument(automation);
  const builder: Builder = { nodes: new Map(), edges: [] };
  addRoutes(builder, document, pipelineNames);

  const steps = [...builder.nodes.values()].filter(
    (node): node is RoundStepNode => node.kind === "step",
  );
  const createdLabels = steps.flatMap((step) =>
    addStepSoftLinks(
      builder,
      document,
      step,
      stepGrants.get(step.stepKey) ?? [],
    ),
  );
  addPeople(builder, document, createdLabels);
  addEngineLinks(builder, document);

  return {
    automationKey: automation.key,
    nodes: [...builder.nodes.values()],
    edges: builder.edges,
  };
}
