import type {
  AnyJsonValue,
  NodeVisitContract,
  PipelineExecutionContract,
  PipelineVersionContract,
} from "@scarn/api/frontend-contracts";
import {
  deriveVisitDisplayStatus,
  pickWorstVisitStatus,
  type VisitDisplayStatus,
} from "./visit-status";

export type ExecutionNodeKind = NodeVisitContract["nodeKind"];

/** One document node in the step rail, with every visit the run made to it. */
export type ExecutionStepItem = {
  nodeId: string;
  /** 1-based order: document order for known nodes, then first-visit order. */
  position: number;
  kind: ExecutionNodeKind;
  title: string;
  /** The step key a step node runs; `null` for wait/succeed/fail nodes. */
  stepKey: string | null;
  /** Worst status across current (non-superseded) visits; `null` when unvisited. */
  status: VisitDisplayStatus | null;
  /** The visit selected by default: the latest current visit, else the latest. */
  visit: NodeVisitContract | null;
  /** Every visit to this node, oldest first: lanes, reruns, superseded history. */
  visits: readonly NodeVisitContract[];
};

type DocumentNode = {
  kind?: AnyJsonValue;
  title?: AnyJsonValue;
  step?: AnyJsonValue;
};

function readDocumentNodes(
  version: PipelineVersionContract | null,
): [string, DocumentNode][] {
  const nodes = version?.definition["nodes"];
  if (!nodes || typeof nodes !== "object" || Array.isArray(nodes)) return [];
  return Object.entries(nodes as Record<string, DocumentNode>);
}

function isNodeKind(value: DocumentNode["kind"]): value is ExecutionNodeKind {
  return (
    value === "step" ||
    value === "wait" ||
    value === "succeed" ||
    value === "fail"
  );
}

export function defaultVisit(
  visits: readonly NodeVisitContract[],
): NodeVisitContract | null {
  return (
    lastMatching(visits, (visit) => visit.status !== "superseded") ??
    visits.at(-1) ??
    null
  );
}

export function lastMatching<T>(
  items: readonly T[],
  predicate: (item: T) => boolean,
): T | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item !== undefined && predicate(item)) return item;
  }
  return null;
}

function currentStatus(
  visits: readonly NodeVisitContract[],
): VisitDisplayStatus | null {
  return pickWorstVisitStatus(
    visits
      .filter((visit) => visit.status !== "superseded")
      .map(deriveVisitDisplayStatus),
  );
}

/**
 * The step rail's rows: one per document node (in document order), then any
 * node a visit reached that the loaded document doesn't know about. Visits
 * are grouped by `nodeId`; a node's lanes and reruns nest under it.
 */
export function buildExecutionStepItems({
  execution,
  version,
}: {
  execution: Pick<PipelineExecutionContract, "visits">;
  version: PipelineVersionContract | null;
}): ExecutionStepItem[] {
  const visitsByNode = new Map<string, NodeVisitContract[]>();
  const ordered = [...execution.visits].sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
  for (const visit of ordered) {
    const existing = visitsByNode.get(visit.nodeId);
    if (existing) existing.push(visit);
    else visitsByNode.set(visit.nodeId, [visit]);
  }

  const items: ExecutionStepItem[] = [];
  const build = (
    nodeId: string,
    kind: ExecutionNodeKind,
    title: string | null,
    stepKey: string | null,
  ) => {
    const visits = visitsByNode.get(nodeId) ?? [];
    items.push({
      nodeId,
      position: items.length + 1,
      kind,
      title: title ?? nodeId,
      stepKey,
      status: currentStatus(visits),
      visit: defaultVisit(visits),
      visits,
    });
  };

  for (const [nodeId, node] of readDocumentNodes(version)) {
    build(
      nodeId,
      isNodeKind(node.kind) ? node.kind : "step",
      typeof node.title === "string" ? node.title : null,
      typeof node.step === "string" ? node.step : null,
    );
  }
  for (const [nodeId, visits] of visitsByNode) {
    if (items.some((item) => item.nodeId === nodeId)) continue;
    build(nodeId, visits[0]?.nodeKind ?? "step", null, null);
  }
  return items;
}

/**
 * The `?step=&visit=` selection that opens a visit: `visitId` is left `null`
 * when the visit is its node's default, keeping the link short.
 */
export function selectionForVisit(
  steps: readonly ExecutionStepItem[],
  visit: Pick<NodeVisitContract, "id" | "nodeId">,
): { kind: "step"; nodeId: string; visitId: string | null } {
  const isDefault =
    steps.find((step) => step.nodeId === visit.nodeId)?.visit?.id === visit.id;
  return {
    kind: "step",
    nodeId: visit.nodeId,
    visitId: isDefault ? null : visit.id,
  };
}

/**
 * Resolves the visit a `?step=&visit=` selection points at: the named visit
 * when it belongs to this node, otherwise the node's default visit.
 */
export function resolveSelectedVisit(
  step: ExecutionStepItem | null,
  visitId: string | null,
): NodeVisitContract | null {
  if (!step) return null;
  if (visitId !== null) {
    const match = step.visits.find((visit) => visit.id === visitId);
    if (match) return match;
  }
  return step.visit;
}
