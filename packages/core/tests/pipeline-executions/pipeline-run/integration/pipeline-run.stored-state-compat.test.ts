/**
 * Pipeline-run engine state is read through the stored readers in
 * `pipeline-run-state-stored.ts`. Rows are written directly to stand in for
 * rows written by older code: the golden fixtures must load through the
 * repo, an unreadable lane or visit drops its run's history from
 * `loadHistories` (and makes `loadHistory` throw).
 */
import { beforeAll, describe, expect } from "bun:test";
import { eq } from "drizzle-orm";
import { createUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import { getDb } from "@/lib/db";
import { laneGroups, lanes, nodeVisits, pipelineRuns } from "@/lib/db/schema";
import type { Logger } from "@scarn/observability/logging";
import { DrizzlePipelineRunRepo } from "@/pipeline-executions/pipeline-run/infra/drizzle-pipeline-run-repo";
import { serialTest } from "tests/utils";
import {
  createRunsProject,
  seedPipeline,
  seedRun,
  seedVisit,
  seedWorkItem,
} from "../../project-runs/integration/project-runs-test-support";
import v1Lane from "../fixtures/v1-lane.json";
import v1NodeVisit from "../fixtures/v1-node-visit.json";
import runError from "../fixtures/pipeline-run-error.json";

const repo = new DrizzlePipelineRunRepo();

const thrownBy = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
    return null;
  } catch (error: unknown) {
    return error;
  }
};

describe("pipeline-run stored state", () => {
  let newRun: (
    error?: { name: string; message: string } | null,
  ) => Promise<UuidV7>;

  beforeAll(async () => {
    const { projectId } = await createRunsProject();
    const pipeline = await seedPipeline(projectId, "Stored state");
    const workItem = await seedWorkItem({ projectId });
    newRun = async (error = null) =>
      await seedRun({
        projectId,
        pipeline,
        workItemId: workItem.id,
        status: error ? "failed" : "succeeded",
        minute: 0,
        error,
      });
  });

  /** A run with a fan-out lane and a visit on it, from the v1 fixtures. */
  const seedFixtureRun = async () => {
    const runId = await newRun();
    const splitVisitId = await seedVisit({
      runId,
      nodeId: "split",
      nodeKind: "step",
      status: "succeeded",
    });
    const groupId = createUuidV7();
    await getDb().insert(laneGroups).values({
      id: groupId,
      pipelineRunId: runId,
      spawnedByVisitId: splitVisitId,
      kind: "each",
      laneCount: 1,
      toleratedFailuresPercent: 50,
      status: "merged",
    });
    const laneId = createUuidV7();
    await getDb()
      .insert(lanes)
      .values({
        ...v1Lane,
        id: laneId,
        laneGroupId: groupId,
        index: 0,
        origin: "split",
        status: "ended",
      });
    const visitId = createUuidV7();
    await getDb()
      .insert(nodeVisits)
      .values({
        ...v1NodeVisit,
        nodeKind: "step",
        id: visitId,
        pipelineRunId: runId,
        nodeId: "review",
        laneId,
        fromVisitId: splitVisitId,
        status: "failed",
        createdAt: new Date(),
      });
    return { runId, groupId, laneId, visitId };
  };

  serialTest("loads a run written at v1 through the repo", async () => {
    const { runId, groupId, laneId, visitId } = await seedFixtureRun();

    const history = await repo.loadHistory(runId);

    expect(
      history.laneGroups.map((group) => [group.id, group.toleratedFailures]),
    ).toEqual([[groupId, { percent: 50 }]]);
    expect(history.lanes).toHaveLength(1);
    expect(history.lanes[0]).toMatchObject({
      id: laneId,
      item: v1Lane.itemJson,
      route: v1Lane.routeJson,
      arrivalArgs: v1Lane.arrivalArgsJson,
      arrivalTransition: v1Lane.arrivalTransitionJson,
    });
    const visit = history.visits.find((entry) => entry.id === visitId);
    expect(visit).toMatchObject({
      transition: v1NodeVisit.transitionJson,
      routing: v1NodeVisit.routingJson,
      input: v1NodeVisit.inputJson,
      error: v1NodeVisit.errorJson,
    });
  });

  serialTest(
    "loadHistories leaves out a run whose history doesn't read",
    async () => {
      const readable = await seedFixtureRun();
      const unreadable = await seedFixtureRun();
      await getDb()
        .update(nodeVisits)
        .set({ transitionJson: { kind: "route" } })
        .where(eq(nodeVisits.id, unreadable.visitId));
      const logged: unknown[] = [];
      const logger = {
        error: (...args: unknown[]) => logged.push(args[0]),
      } as unknown as Logger;

      const histories = await new DrizzlePipelineRunRepo(logger).loadHistories([
        readable.runId,
        unreadable.runId,
      ]);

      expect([...histories.keys()]).toEqual([readable.runId]);
      expect(logged).toContainEqual(
        expect.objectContaining({
          table: "node_visits",
          nodeVisitId: unreadable.visitId,
        }),
      );
      expect(logged).toContainEqual(
        expect.objectContaining({
          table: "pipeline_runs",
          pipelineRunId: unreadable.runId,
        }),
      );
    },
  );

  serialTest("loadHistory fails clearly on an unreadable lane", async () => {
    const { runId, laneId } = await seedFixtureRun();
    await getDb()
      .update(lanes)
      .set({ schemaVersion: 99 })
      .where(eq(lanes.id, laneId));

    const error = await thrownBy(() => repo.loadHistory(runId));

    expect(error).toMatchObject({
      code: "PIPELINE_RUN_HISTORY_UNREADABLE",
    });
    expect((error as Error).message).toContain(laneId);
  });

  serialTest(
    "reads a run's error and skips a run whose error doesn't read",
    async () => {
      const failed = await newRun(runError.errorJson);
      const unreadable = await newRun();
      await getDb()
        .update(pipelineRuns)
        .set({ errorJson: { name: "NoMessage" } })
        .where(eq(pipelineRuns.id, unreadable));

      expect((await repo.load(failed))?.errorJson).toEqual(runError.errorJson);
      expect(
        (await repo.loadMany([failed, unreadable])).map((run) => run.id),
      ).toEqual([failed]);
      expect(await thrownBy(() => repo.load(unreadable))).toMatchObject({
        code: "PIPELINE_RUN_ROW_UNREADABLE",
      });
    },
  );
});
