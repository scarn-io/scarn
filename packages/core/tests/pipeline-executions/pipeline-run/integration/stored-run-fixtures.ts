/**
 * Writes a golden stored-run fixture (`fixtures/v1-*-run.json`) as raw rows,
 * standing in for a run an older release wrote. Rows reference each other
 * by fixture `key`; the seeder gives each a fresh id and links them once
 * every row exists.
 */
import { eq } from "drizzle-orm";
import { createUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import { getDb } from "@/lib/db";
import { laneGroups, lanes, nodeVisits } from "@/lib/db/schema";
import {
  at,
  seedRun,
  type seedPipeline,
} from "../../project-runs/integration/project-runs-test-support";
import finishedRun from "../fixtures/v1-finished-run.json";
import failedRun from "../fixtures/v1-failed-run.json";

type VisitRow = (typeof finishedRun.visits)[number];
type LaneGroupRow = (typeof finishedRun.laneGroups)[number];
type LaneRow = (typeof finishedRun.lanes)[number];

/** A stored-run fixture: the run row and its visits, lane groups and lanes. */
export type StoredRunFixture = {
  run: {
    status: "succeeded" | "failed";
    endNodeId: string | null;
    errorJson: { name: string; message: string } | null;
  };
  visits: readonly VisitRow[];
  laneGroups: readonly LaneGroupRow[];
  lanes: readonly LaneRow[];
};

export const v1FinishedRun = finishedRun as StoredRunFixture;
export const v1FailedRun = failedRun as StoredRunFixture;

/** The pipeline document both fixtures ran against. */
export const storedRunDefinition = finishedRun.definitionJson;

export type SeededStoredRun = {
  runId: UuidV7;
  /** Row ids by fixture key, across visits, lane groups and lanes. */
  ids: Map<string, UuidV7>;
};

const idOf = (ids: Map<string, UuidV7>, key: string): UuidV7 => {
  const id = ids.get(key);
  if (!id) {
    throw new Error(`The fixture has no row keyed ${key}`);
  }
  return id;
};

const refOf = (ids: Map<string, UuidV7>, key: string | null): UuidV7 | null =>
  key === null ? null : idOf(ids, key);

export const seedStoredRun = async (input: {
  fixture: StoredRunFixture;
  projectId: UuidV7;
  pipeline: Awaited<ReturnType<typeof seedPipeline>>;
  workItemId: UuidV7;
  minute: number;
}): Promise<SeededStoredRun> => {
  const { fixture } = input;
  const runId = await seedRun({
    projectId: input.projectId,
    pipeline: input.pipeline,
    workItemId: input.workItemId,
    status: fixture.run.status,
    endNodeId: fixture.run.endNodeId,
    error: fixture.run.errorJson,
    minute: input.minute,
  });
  const ids = new Map<string, UuidV7>(
    [...fixture.visits, ...fixture.laneGroups, ...fixture.lanes].map((row) => [
      row.key,
      createUuidV7(),
    ]),
  );
  const db = getDb();

  for (const visit of fixture.visits) {
    await db.insert(nodeVisits).values({
      id: idOf(ids, visit.key),
      pipelineRunId: runId,
      schemaVersion: visit.schemaVersion,
      nodeId: visit.nodeId,
      nodeKind: visit.nodeKind as "step" | "wait" | "succeed" | "fail",
      transitionJson: visit.transitionJson,
      routingJson: visit.routingJson,
      status: visit.status as "succeeded",
      inputJson: visit.inputJson,
      resultJson: visit.resultJson,
      errorJson: visit.errorJson,
      createdAt: at(input.minute + visit.minute),
    });
  }
  for (const group of fixture.laneGroups) {
    await db.insert(laneGroups).values({
      id: idOf(ids, group.key),
      pipelineRunId: runId,
      spawnedByVisitId: idOf(ids, group.spawnedBy),
      parentLaneId: refOf(ids, group.parentLane),
      kind: group.kind as "each" | "all",
      laneCount: group.laneCount,
      maxConcurrency: group.maxConcurrency,
      toleratedFailuresCount: group.toleratedFailuresCount,
      toleratedFailuresPercent: group.toleratedFailuresPercent,
      status: group.status as "merged",
    });
  }
  for (const lane of fixture.lanes) {
    await db.insert(lanes).values({
      id: idOf(ids, lane.key),
      laneGroupId: idOf(ids, lane.group),
      schemaVersion: lane.schemaVersion,
      index: lane.index,
      itemJson: lane.itemJson,
      routeJson: lane.routeJson,
      origin: lane.origin as "split" | "merge",
      status: lane.status as "arrived",
      arrivedAtNodeId: lane.arrivedAtNodeId,
      arrivalArgsJson: lane.arrivalArgsJson,
      arrivedFromVisitId: refOf(ids, lane.arrivedFrom),
      arrivalTransitionJson: lane.arrivalTransitionJson,
      mergedIntoVisitId: refOf(ids, lane.mergedInto),
    });
  }
  for (const visit of fixture.visits) {
    await db
      .update(nodeVisits)
      .set({
        fromVisitId: refOf(ids, visit.from),
        laneId: refOf(ids, visit.lane),
        fromLaneGroupId: refOf(ids, visit.fromLaneGroup),
      })
      .where(eq(nodeVisits.id, idOf(ids, visit.key)));
  }
  return { runId, ids };
};
