/**
 * Merges: firing a group's merges once no pending or active lane can still
 * reach them. A partial merge of an `all` split continues its arrived lanes
 * as one continuation lane of the same group; a closing merge marks the group
 * merged and enters the merge on the parent lane (or the top level), or
 * carries the combined args up as the parent lane's arrival when it closes
 * (or partially merges) the parent split too.
 */
import {
  allSplitIdOf,
  splitIdOf,
  type Merge,
  type Split,
} from "@scarn/shared-core/pipelines";
import type {
  JsonObject,
  JsonValue,
} from "@scarn/sdk/contracts/pipeline-document";
import { enclosingGroups, latestVisitOnLane } from "./chain";
import { enterNode } from "./enter";
import { arriveAtMerge, endPath, NO_ARRIVAL } from "./lanes";
import {
  emit,
  groupById,
  laneById,
  lanesOf,
  visitById,
  type EngineContext,
} from "./state";
import type { Lane, LaneGroup, VisitTransition } from "./types";

/** The route an `each` group's lanes start with: its first lane's, or the route its spawner (or `all` parent lane) took. */
function eachRouteOf(
  ctx: EngineContext,
  group: LaneGroup,
): VisitTransition | undefined {
  const first = lanesOf(ctx, group.id).find((lane) => lane.origin === "split");
  if (first !== undefined) {
    return first.route;
  }
  if (group.parentLaneId !== null) {
    const parent = laneById(ctx, group.parentLaneId);
    if (
      groupById(ctx, parent.laneGroupId).spawnedByVisitId ===
      group.spawnedByVisitId
    ) {
      return parent.route;
    }
  }
  return visitById(ctx, group.spawnedByVisitId).routing?.taken?.[0];
}

function routeKey(nodeId: string, route: VisitTransition): string {
  return splitIdOf(
    nodeId,
    route.kind === "otherwise" ? "otherwise" : "route",
    route.index,
  );
}

/** The split in the document that spawned the group. */
export function splitOf(
  ctx: EngineContext,
  group: LaneGroup,
): Split | undefined {
  const spawner = visitById(ctx, group.spawnedByVisitId);
  if (group.kind === "all") {
    return ctx.splits.splits.get(allSplitIdOf(spawner.nodeId));
  }
  const route = eachRouteOf(ctx, group);
  return route === undefined
    ? undefined
    : ctx.splits.splits.get(routeKey(spawner.nodeId, route));
}

/**
 * Whether the lane, from where it is now, can still reach `mergeNodeId`. A
 * lane with no visit of its own yet (pending, or an `all` lane running a
 * child `each` group) counts from its route's entry.
 */
function canReach(
  ctx: EngineContext,
  lane: Lane,
  split: Split,
  mergeNodeId: string,
): boolean {
  const current =
    lane.status === "pending"
      ? undefined
      : latestVisitOnLane(ctx, lane.id)?.nodeId;
  const from =
    current ?? split.routes.get(routeKey(split.node, lane.route))?.to;
  return (
    from !== undefined &&
    (from === mergeNodeId || ctx.splits.reachable(from).has(mergeNodeId))
  );
}

/** Whether split `id` is `ancestorId` or nested inside it. */
function isWithin(ctx: EngineContext, id: string, ancestorId: string): boolean {
  let current: string | null = id;
  while (current !== null) {
    if (current === ancestorId) {
      return true;
    }
    current = ctx.splits.splits.get(current)?.parent ?? null;
  }
  return false;
}

/**
 * The merge's args from the group's arrived lanes, in lane order: fields
 * from item lanes are concatenated (`[]` when none arrived), other fields
 * are copied.
 */
export function combineArrivals(
  ctx: EngineContext,
  group: LaneGroup,
  mergeNodeId: string,
): JsonObject {
  const split = splitOf(ctx, group);
  const fields = ctx.splits.merges.get(mergeNodeId)?.fields;
  const combined: Record<string, JsonValue> = {};
  for (const field of fields?.values() ?? []) {
    if (
      field.fromEach &&
      split !== undefined &&
      isWithin(ctx, field.split, split.id)
    ) {
      combined[field.name] = [];
    }
  }
  for (const lane of lanesOf(ctx, group.id)) {
    if (lane.status !== "arrived" || lane.arrivedAtNodeId !== mergeNodeId) {
      continue;
    }
    for (const [name, value] of Object.entries(lane.arrivalArgs ?? {})) {
      const existing = combined[name];
      if (fields?.get(name)?.fromEach !== true) {
        combined[name] = value;
      } else if (Array.isArray(existing)) {
        existing.push(...(Array.isArray(value) ? value : [value]));
      } else {
        combined[name] = Array.isArray(value) ? [...value] : [value];
      }
    }
  }
  return combined;
}

function isBusy(
  ctx: EngineContext,
  group: LaneGroup,
  split: Split | undefined,
  mergeNodeId: string | null,
): boolean {
  return lanesOf(ctx, group.id).some(
    (lane) =>
      (lane.status === "pending" || lane.status === "active") &&
      (split === undefined ||
        mergeNodeId === null ||
        canReach(ctx, lane, split, mergeNodeId)),
  );
}

/** Fires a partial merge of `group` once a lane arrived at it, no lane can still reach it, and it hasn't fired yet. */
function firePartialMerge(
  ctx: EngineContext,
  group: LaneGroup,
  split: Split,
  merge: Merge,
): void {
  const arrived = lanesOf(ctx, group.id).some(
    (lane) =>
      lane.status === "arrived" && lane.arrivedAtNodeId === merge.nodeId,
  );
  const fired = ctx.visits.some(
    (visit) =>
      visit.nodeId === merge.nodeId &&
      visit.fromLaneGroupId === group.id &&
      visit.status !== "superseded",
  );
  if (!arrived || fired || isBusy(ctx, group, split, merge.nodeId)) {
    return;
  }
  const args = combineArrivals(ctx, group, merge.nodeId);
  const lane: Lane = {
    id: ctx.options.newId(),
    laneGroupId: group.id,
    index:
      Math.max(
        group.laneCount - 1,
        ...lanesOf(ctx, group.id).map((entry) => entry.index),
      ) + 1,
    item: null,
    route: { kind: "merge", index: 0 },
    origin: "merge",
    status: "active",
    ...NO_ARRIVAL,
  };
  emit(ctx, { type: "createLane", lane });
  const visit = enterNode(ctx, {
    nodeId: merge.nodeId,
    input: args,
    laneId: lane.id,
    fromVisitId: null,
    fromLaneGroupId: group.id,
    transition: { kind: "merge", index: 0 },
  });
  markMerged(ctx, group.id, merge.nodeId, visit.id);
}

/**
 * Fires the group's partial merges, then its closing merge, once no pending
 * or active lane can still reach them. A group with no closing merge ends
 * the parent's path once every lane is done.
 */
export function checkMerge(ctx: EngineContext, groupId: string): void {
  const group = groupById(ctx, groupId);
  if (group.status !== "open") {
    return;
  }
  const split = splitOf(ctx, group);
  if (split?.kind === "all") {
    for (const merge of ctx.splits.merges.values()) {
      if (
        merge.partialOf === split.id &&
        groupById(ctx, groupId).status === "open"
      ) {
        firePartialMerge(ctx, group, split, merge);
      }
    }
    if (groupById(ctx, groupId).status !== "open") {
      return;
    }
  }
  const mergeNodeId = split?.merge ?? null;
  if (isBusy(ctx, group, split, mergeNodeId)) {
    return;
  }
  emit(ctx, { type: "updateLaneGroup", groupId, patch: { status: "merged" } });
  if (split === undefined || mergeNodeId === null) {
    endPath(ctx, group.parentLaneId);
    return;
  }
  const args = combineArrivals(ctx, group, mergeNodeId);
  const merge = ctx.splits.merges.get(mergeNodeId);
  const parentSplit =
    group.parentLaneId === null
      ? undefined
      : splitOf(
          ctx,
          groupById(ctx, laneById(ctx, group.parentLaneId).laneGroupId),
        );
  if (
    group.parentLaneId !== null &&
    parentSplit !== undefined &&
    (merge?.closes.includes(parentSplit.id) === true ||
      merge?.partialOf === parentSplit.id)
  ) {
    arriveAtMerge(ctx, group.parentLaneId, mergeNodeId, args, null, null);
    return;
  }
  const visit = enterNode(ctx, {
    nodeId: mergeNodeId,
    input: args,
    laneId: group.parentLaneId,
    fromVisitId: null,
    fromLaneGroupId: group.id,
    transition: { kind: "merge", index: 0 },
  });
  markMerged(ctx, group.id, mergeNodeId, visit.id);
}

/** Points every lane that arrived at the merge, in `groupId` or a group nested in it, at the merge visit. */
export function markMerged(
  ctx: EngineContext,
  groupId: string,
  mergeNodeId: string,
  visitId: string,
): void {
  for (const lane of ctx.lanes) {
    if (
      lane.status === "arrived" &&
      lane.arrivedAtNodeId === mergeNodeId &&
      lane.mergedIntoVisitId !== visitId &&
      enclosingGroups(ctx, lane.id).some((entry) => entry.groupId === groupId)
    ) {
      emit(ctx, {
        type: "updateLane",
        laneId: lane.id,
        patch: { mergedIntoVisitId: visitId },
      });
    }
  }
}
