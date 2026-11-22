/**
 * Walking the visit chain: reach-back (`nodes.<id>.*`), the reference
 * context a transition is resolved in, base-branch resolution, and the
 * visits that came after a visit (for reruns).
 */
import type { JsonValue } from "@scarn/sdk/contracts/pipeline-document";
import type {
  NodeValues,
  ReferenceContext,
} from "@scarn/shared-core/pipelines";
import {
  groupById,
  laneById,
  lanesOf,
  latestTaskOf,
  type EngineContext,
} from "./state";
import type { RoutingNote, Visit } from "./types";

/** The visit that led to this one; through a join, the visit that spawned the lanes. */
export function predecessorOf(
  ctx: EngineContext,
  visit: Pick<Visit, "fromVisitId" | "fromLaneGroupId">,
): Visit | undefined {
  const previousId =
    visit.fromLaneGroupId === null
      ? visit.fromVisitId
      : groupById(ctx, visit.fromLaneGroupId).spawnedByVisitId;
  if (previousId === null) {
    return undefined;
  }
  return ctx.visits.find(
    (candidate) =>
      candidate.id === previousId && candidate.status !== "superseded",
  );
}

export function visitResult(
  ctx: EngineContext,
  visit: Visit,
): JsonValue | undefined {
  if (visit.nodeKind === "wait" || visit.resultTaskId === null) {
    return visit.result ?? undefined;
  }
  return ctx.tasks.get(visit.resultTaskId)?.result ?? undefined;
}

/** Finds the nearest visit to `nodeId`, starting at `from` itself. */
export function reachBack(
  ctx: EngineContext,
  from: Visit | undefined,
  nodeId: string,
): NodeValues | undefined {
  let current = from;
  while (current !== undefined) {
    if (current.nodeId === nodeId) {
      const result = visitResult(ctx, current);
      return result === undefined
        ? { input: current.input }
        : { input: current.input, result };
    }
    current = predecessorOf(ctx, current);
  }
  return undefined;
}

/** Work-item fields keyed by alias, read through the document's `workItemFields`. */
export function workItemContext(
  ctx: EngineContext,
): NonNullable<ReferenceContext["workItem"]> {
  const fields: Record<string, JsonValue> = {};
  for (const [alias, label] of Object.entries(
    ctx.document.workItemFields ?? {},
  )) {
    const value = ctx.workItem.fields[label];
    if (value !== undefined) {
      fields[alias] = value;
    }
  }
  return {
    title: ctx.workItem.title,
    description: ctx.workItem.description,
    fields,
  };
}

/** The context a transition out of `source` is resolved in. */
export function contextFor(
  ctx: EngineContext,
  source: Visit | undefined,
  extra: Partial<ReferenceContext> = {},
): ReferenceContext {
  const own: ReferenceContext = {};
  if (source !== undefined) {
    own.input = source.input;
    const result = visitResult(ctx, source);
    if (result !== undefined) {
      own.result = result;
    }
  }
  return {
    workItem: workItemContext(ctx),
    nodes: (nodeId) => reachBack(ctx, source, nodeId),
    ...own,
    ...extra,
  };
}

/** The latest non-superseded visit on a lane (its own lane, not nested ones). */
export function latestVisitOnLane(
  ctx: EngineContext,
  laneId: string,
): Visit | undefined {
  return ctx.visits
    .filter((visit) => visit.laneId === laneId && visit.status !== "superseded")
    .at(-1);
}

function ownBranch(ctx: EngineContext, visit: Visit): string | null {
  const taskId = visit.resultTaskId ?? latestTaskOf(ctx, visit.id)?.taskId;
  return taskId === undefined
    ? null
    : (ctx.tasks.get(taskId)?.workBranch ?? null);
}

export interface BranchOutcome {
  branch: string | null;
  notes: RoutingNote[];
}

/**
 * The visits whose `partial` routes arrived at `mergeNodeId` from the lanes
 * of `groupId` and of the groups nested in it, in lane order.
 */
function arrivalsAt(
  ctx: EngineContext,
  groupId: string,
  mergeNodeId: string,
): Visit[] {
  return ctx.lanes
    .filter(
      (lane) =>
        lane.status === "arrived" &&
        lane.arrivedAtNodeId === mergeNodeId &&
        enclosingGroups(ctx, lane.id).some(
          (entry) => entry.groupId === groupId,
        ),
    )
    .sort((left, right) => left.index - right.index)
    .flatMap((lane) => {
      const visit =
        lane.arrivedFromVisitId === null
          ? undefined
          : ctx.visits.find(
              (candidate) =>
                candidate.id === lane.arrivedFromVisitId &&
                candidate.status !== "superseded",
            );
      return visit === undefined ? [] : [visit];
    });
}

/** Every arriving lane's branch: shared if they agree, else none and a `branch_ambiguous` note. */
function branchAtMerge(
  ctx: EngineContext,
  groupId: string,
  mergeNodeId: string,
): BranchOutcome {
  const outcomes = arrivalsAt(ctx, groupId, mergeNodeId).map((visit) =>
    branchFrom(ctx, visit),
  );
  const notes = outcomes.flatMap((outcome) => outcome.notes);
  const branches = outcomes.map((outcome) => outcome.branch);
  const unique = new Set(branches);
  if (unique.size === 1 && notes.length === 0) {
    return { branch: branches[0] ?? null, notes };
  }
  if (unique.size <= 1) {
    return { branch: null, notes };
  }
  return {
    branch: null,
    notes: [...notes, { kind: "branch_ambiguous", branches }],
  };
}

/** The branch a visit's work ends on: its own Task's, or the nearest one back along the chain. */
export function branchFrom(ctx: EngineContext, visit: Visit): BranchOutcome {
  let current: Visit | undefined = visit;
  while (current !== undefined) {
    const own = ownBranch(ctx, current);
    if (own !== null) {
      return { branch: own, notes: [] };
    }
    if (current.fromLaneGroupId !== null) {
      return branchAtMerge(ctx, current.fromLaneGroupId, current.nodeId);
    }
    current = predecessorOf(ctx, current);
  }
  return { branch: null, notes: [] };
}

/** The base branch for a new visit to `nodeId` entering through `from`. */
export function baseBranchFor(
  ctx: EngineContext,
  from: Pick<Visit, "nodeId" | "fromVisitId" | "fromLaneGroupId">,
): BranchOutcome {
  if (from.fromLaneGroupId !== null) {
    return branchAtMerge(ctx, from.fromLaneGroupId, from.nodeId);
  }
  const previous = predecessorOf(ctx, from);
  return previous === undefined
    ? { branch: null, notes: [] }
    : branchFrom(ctx, previous);
}

/**
 * `root` and every visit that came after it: visits it led to, visits on the
 * lanes of groups it (or a later visit) spawned, and the merge visits it can
 * reach of the groups its lane is in. Superseded visits are skipped.
 */
export function descendantsOf(ctx: EngineContext, root: Visit): Visit[] {
  const found = new Map<string, Visit>([[root.id, root]]);
  const queue = [root];
  const add = (visit: Visit) => {
    if (visit.status !== "superseded" && !found.has(visit.id)) {
      found.set(visit.id, visit);
      queue.push(visit);
    }
  };
  while (queue.length > 0) {
    const current = queue.shift() as Visit;
    const groupIds = new Set(
      enclosingGroups(ctx, current.laneId).map((entry) => entry.groupId),
    );
    for (const visit of ctx.visits) {
      if (
        (visit.fromVisitId === current.id && visit.fromLaneGroupId === null) ||
        (visit.fromLaneGroupId !== null &&
          groupIds.has(visit.fromLaneGroupId) &&
          ctx.splits.reachable(current.nodeId).has(visit.nodeId))
      ) {
        add(visit);
      }
    }
    for (const group of ctx.groups) {
      if (group.spawnedByVisitId !== current.id) {
        continue;
      }
      const laneIds = new Set(lanesOf(ctx, group.id).map((lane) => lane.id));
      for (const visit of ctx.visits) {
        if (
          (visit.laneId !== null && laneIds.has(visit.laneId)) ||
          visit.fromLaneGroupId === group.id
        ) {
          add(visit);
        }
      }
    }
  }
  return [...found.values()];
}

/** The lane's group and every enclosing group, innermost first. */
export function enclosingGroups(ctx: EngineContext, laneId: string | null) {
  const chain: { laneId: string; groupId: string }[] = [];
  let current = laneId;
  while (current !== null) {
    const lane = laneById(ctx, current);
    chain.push({ laneId: current, groupId: lane.laneGroupId });
    current = groupById(ctx, lane.laneGroupId).parentLaneId;
  }
  return chain;
}
