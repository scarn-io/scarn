/**
 * What an overrule would do, read off the commands `decide` returned for it:
 * the visits it supersedes, the Tasks it cancels, the lanes it adds and
 * removes, the merges that fire again and the nodes entered straight away.
 */
import {
  routeAt,
  type PipelineDocument,
} from "@scarn/sdk/contracts/pipeline-document";
import type { MissingArg } from "@scarn/shared-core/pipelines";
import { applyCommands } from "./state";
import type {
  Command,
  Lane,
  RunState,
  Visit,
  VisitStatus,
  VisitTransition,
} from "./types";

export interface OverrulePreviewLane {
  route: VisitTransition;
  label?: string;
}

export interface OverrulePreview {
  superseded: { visitId: string; nodeId: string; status: VisitStatus }[];
  cancelledTasks: number;
  lanesAdded: OverrulePreviewLane[];
  lanesRemoved: OverrulePreviewLane[];
  /** Merge node ids that will fire again. */
  mergesRerun: string[];
  /** Node ids entered straight away. */
  started: string[];
  reopensRun: boolean;
  /** The args the overrule accepts as missing. */
  missing: MissingArg[];
}

const unique = (values: readonly string[]): string[] => [...new Set(values)];

function laneOf(
  document: PipelineDocument,
  visit: Visit,
  route: VisitTransition,
): OverrulePreviewLane {
  const node = document.nodes[visit.nodeId];
  const next =
    node?.kind === "step" || node?.kind === "wait" ? node.next : undefined;
  const label =
    route.kind === "route" || route.kind === "otherwise"
      ? routeAt(next, route.kind, route.index)?.label
      : undefined;
  return label === undefined ? { route } : { route, label };
}

function lanesSpawnedBy(state: RunState, visitId: string): Map<string, Lane> {
  const groupIds = new Set(
    state.laneGroups
      .filter((group) => group.spawnedByVisitId === visitId)
      .map((group) => group.id),
  );
  return new Map(
    state.lanes
      .filter(
        (lane) => lane.origin === "split" && groupIds.has(lane.laneGroupId),
      )
      .map((lane) => [lane.id, lane]),
  );
}

/**
 * The superseded merges that will fire again: their lane group, once the
 * commands apply, is open (it fires when its lanes are ready) or merged
 * again (it fired straight away).
 */
function mergesFiringAgain(
  state: RunState,
  commands: readonly Command[],
  superseded: readonly Visit[],
): string[] {
  const after = applyCommands(state, commands);
  const liveGroups = new Set(
    after.laneGroups
      .filter((group) => group.status !== "failed")
      .map((group) => group.id),
  );
  return unique(
    superseded
      .filter(
        (visit) =>
          visit.transition.kind === "merge" &&
          visit.fromLaneGroupId !== null &&
          liveGroups.has(visit.fromLaneGroupId),
      )
      .map((visit) => visit.nodeId),
  );
}

/** Summarizes the commands of an overrule of `visitId`, applied to `state`. */
export function summarizeOverrule(
  document: PipelineDocument,
  state: RunState,
  visitId: string,
  commands: readonly Command[],
): OverrulePreview {
  const visits = new Map(state.visits.map((visit) => [visit.id, visit]));
  const overruled = visits.get(visitId);
  const spawned = lanesSpawnedBy(state, visitId);
  const superseded: Visit[] = [];
  const cancelledTasks = new Set<string>();
  const lanesAdded: OverrulePreviewLane[] = [];
  const lanesRemoved: OverrulePreviewLane[] = [];
  const started: string[] = [];
  let reopensRun = false;
  let missing: MissingArg[] = [];

  for (const command of commands) {
    switch (command.type) {
      case "updateVisit": {
        const visit = visits.get(command.visitId);
        if (visit !== undefined && command.patch.status === "superseded") {
          superseded.push(visit);
        }
        const overrule = command.patch.routing?.overrules?.at(-1);
        if (command.visitId === visitId && overrule !== undefined) {
          missing = overrule.missingArgs;
        }
        break;
      }
      case "cancelTask":
        cancelledTasks.add(command.taskId);
        break;
      case "createLane":
        if (overruled !== undefined && command.lane.origin === "split") {
          lanesAdded.push(laneOf(document, overruled, command.lane.route));
        }
        break;
      case "createLaneGroup":
        if (
          overruled !== undefined &&
          command.group.spawnedByVisitId === visitId
        ) {
          for (const lane of command.lanes) {
            lanesAdded.push(laneOf(document, overruled, lane.route));
          }
        }
        break;
      case "updateLane": {
        const lane = spawned.get(command.laneId);
        if (
          overruled !== undefined &&
          lane !== undefined &&
          command.patch.status === "cancelled"
        ) {
          lanesRemoved.push(laneOf(document, overruled, lane.route));
        }
        break;
      }
      case "createVisit":
        started.push(command.visit.nodeId);
        break;
      case "updateRun":
        reopensRun ||=
          command.patch.status === "active" &&
          state.run.status !== "active" &&
          state.run.status !== "waiting";
        break;
      default:
        break;
    }
  }

  return {
    superseded: superseded.map((visit) => ({
      visitId: visit.id,
      nodeId: visit.nodeId,
      status: visit.status,
    })),
    cancelledTasks: cancelledTasks.size,
    lanesAdded,
    lanesRemoved,
    mergesRerun: mergesFiringAgain(state, commands, superseded),
    started: unique(started),
    reopensRun,
    missing,
  };
}
