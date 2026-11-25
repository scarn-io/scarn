/**
 * The Runs list and run history over golden stored runs: a finished run
 * (fan-out lane group, a reroute, a tolerated lane failure, an overrule and
 * a rerun) and a failed run, written as raw v1 rows, and a failed
 * standalone Task. Search reads `pipeline_runs.error_json ->> 'message'`,
 * `node_visits.error_json ->> 'message'` and `tasks.error_json ->> 'message'`
 * straight from those rows.
 */
import { beforeAll, describe, expect } from "bun:test";
import { eq } from "drizzle-orm";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { getDb } from "@/lib/db";
import { nodeVisits } from "@/lib/db/schema";
import { concurrentTest, unwrapAsync } from "tests/utils";
import {
  seedStoredRun,
  storedRunDefinition,
  v1FailedRun,
  v1FinishedRun,
  type SeededStoredRun,
} from "../../pipeline-run/integration/stored-run-fixtures";
import {
  apiClient,
  createRunsProject,
  listRuns,
  seedPipeline,
  seedWorkItem,
  type RunsProject,
} from "./project-runs-test-support";
import {
  insertStoredTask,
  seedStoredTaskOwners,
  v1FailedTask,
} from "../../../tasks/task/integration/stored-task-fixtures";

describe("project runs: stored v1 runs", () => {
  let project: RunsProject;
  let finished: SeededStoredRun;
  let failed: SeededStoredRun;
  let retiredKind: SeededStoredRun;
  let failedTaskId: UuidV7;

  beforeAll(async () => {
    project = await createRunsProject();
    const { projectId } = project;
    const pipeline = await seedPipeline(
      projectId,
      "Fixture release",
      storedRunDefinition,
    );
    const workItem = await seedWorkItem({ projectId, title: "Ship it" });
    const seed = async (fixture: typeof v1FinishedRun, minute: number) =>
      await seedStoredRun({
        fixture,
        projectId,
        pipeline,
        workItemId: workItem.id,
        minute,
      });
    finished = await seed(v1FinishedRun, 0);
    failed = await seed(v1FailedRun, 10);
    retiredKind = await seed(v1FinishedRun, 20);
    await getDb()
      .update(nodeVisits)
      .set({ transitionJson: { kind: "retired-kind", index: 0 } })
      .where(eq(nodeVisits.id, retiredKind.ids.get("shipped") as UuidV7));
    failedTaskId = await insertStoredTask(
      await seedStoredTaskOwners(projectId),
      v1FailedTask,
    );
  });

  const searchIds = async (q: string) =>
    (await listRuns(project.owner, project.projectId, { q })).runs
      .map((run) => run.id)
      .sort();

  concurrentTest("search matches the run's error message", async () => {
    expect(await searchIds("out of disk space")).toEqual([failed.runId]);
  });

  concurrentTest("search matches a visit's error message", async () => {
    expect(await searchIds("container was killed")).toEqual([failed.runId]);
    expect(await searchIds("health probe timed out")).toEqual(
      [finished.runId, retiredKind.runId].sort(),
    );
  });

  concurrentTest(
    "search matches a standalone Task's error message",
    async () => {
      expect(await searchIds("the build broke")).toEqual([failedTaskId]);
    },
  );

  concurrentTest(
    "search matches the error of a visit a rerun superseded",
    async () => {
      expect(await searchIds("lost its lease")).toEqual(
        [finished.runId, retiredKind.runId].sort(),
      );
    },
  );

  const getExecution = async (runId: UuidV7) =>
    await unwrapAsync(
      apiClient.api["pipeline-executions"]({
        pipelineExecutionId: runId,
      }).get({ headers: { ...project.owner.authHeaders } }),
    );

  concurrentTest("the finished run's history reads back", async () => {
    const execution = await getExecution(finished.runId);

    expect(
      execution.laneGroups.map((group) => [
        group.id,
        group.kind,
        group.laneCount,
        group.toleratedFailures,
        group.status,
      ]),
    ).toEqual([
      [
        finished.ids.get("services") as UuidV7,
        "each",
        2,
        { count: 1 },
        "merged",
      ],
    ]);
    expect(
      execution.lanes.map((lane) => [lane.index, lane.status, lane.item]),
    ).toEqual([
      [0, "arrived", { name: "api" }],
      [1, "failed", { name: "web" }],
    ]);
    const review = execution.visits.find(
      (visit) => visit.id === finished.ids.get("review"),
    );
    expect(review?.transition).toEqual({ kind: "merge", index: 0 });
    expect(review?.routing).toMatchObject({
      taken: [{ kind: "otherwise", index: 0 }],
      overrules: [
        expect.objectContaining({ to: [{ kind: "otherwise", index: 0 }] }),
      ],
    });
    expect(
      execution.visits
        .filter((visit) => visit.status === "superseded")
        .map((visit) => visit.nodeId)
        .sort(),
    ).toEqual(["blocked", "plan"]);
  });

  concurrentTest("the failed run's error reads back", async () => {
    const execution = await getExecution(failed.runId);

    expect(execution.error).toEqual(v1FailedRun.run.errorJson);
  });

  concurrentTest(
    "a transition kind the engine no longer knows still serializes",
    async () => {
      const execution = await getExecution(retiredKind.runId);

      expect(
        execution.visits.find(
          (visit) => visit.id === retiredKind.ids.get("shipped"),
        )?.transition,
      ).toEqual({ kind: "retired-kind", index: 0 });
    },
  );
});
