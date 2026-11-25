/**
 * Stored `pipeline_graph_versions` rows stay readable as the pipeline
 * document schema evolves. Rows are written directly, bypassing publish, to
 * stand in for documents published by older code. See
 * `docs/persistence/json-columns.md`.
 */
import { beforeAll, describe, expect } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { pipelineGraphVersions, pipelineGraphs } from "@/lib/db/schema";
import { createUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import { PersistenceError } from "@/lib/errors";
import type { StoredPipelineGraphVersionColumns } from "@/pipeline-definitions/pipeline-graph/contracts/pipeline-graph-version-stored";
import { DrizzlePipelineGraphRepo } from "@/pipeline-definitions/pipeline-graph/infra/drizzle-pipeline-graph-repo";
import { DrizzlePipelineGraphVersionRepo } from "@/pipeline-definitions/pipeline-graph/infra/drizzle-pipeline-graph-version-repo";
import { DrizzleTaskRunStepKeyReader } from "@/pipeline-executions/pipeline-run/infra/drizzle-task-run-step-key-reader";
import { serialTest } from "tests/utils";
import {
  createRunsProject,
  seedRun,
  seedTask,
  seedTaskRun,
  seedVisit,
  seedWorkItem,
} from "tests/pipeline-executions/project-runs/integration/project-runs-test-support";
import v1MultiNodeFixture from "../fixtures/v1-multi-node.json";
import v1WayfinderFixture from "../fixtures/v1-wayfinder.json";

const versionRepo = new DrizzlePipelineGraphVersionRepo();
const graphRepo = new DrizzlePipelineGraphRepo();

const insertGraph = async (projectId: UuidV7): Promise<UuidV7> => {
  const id = createUuidV7();
  await getDb()
    .insert(pipelineGraphs)
    .values({
      id,
      projectId,
      key: `stored_compat_${crypto.randomUUID()}`,
      name: "Stored compat",
    });
  return id;
};

const insertVersion = async (
  pipelineGraphId: UuidV7,
  version: number,
  { definitionJson }: StoredPipelineGraphVersionColumns,
): Promise<UuidV7> => {
  const id = createUuidV7();
  await getDb().insert(pipelineGraphVersions).values({
    id,
    pipelineGraphId,
    version,
    definitionJson,
    schemaVersion: 1,
    contentHash: crypto.randomUUID(),
  });
  return id;
};

const unreadable = { definitionJson: { kind: "automation" } };

const rejectionOf = async <T>(promise: Promise<T>) => {
  try {
    await promise;
    return null;
  } catch (error) {
    return error;
  }
};

describe("pipeline graph version stored document compatibility", () => {
  let projectId: UuidV7;

  beforeAll(async () => {
    ({ projectId } = await createRunsProject());
  });

  for (const [name, fixture] of [
    ["multi-node", v1MultiNodeFixture],
    ["wayfinder", v1WayfinderFixture],
  ] as const) {
    serialTest(`reads the v1 ${name} fixture through the repo`, async () => {
      const graphId = await insertGraph(projectId);
      const versionId = await insertVersion(graphId, 1, fixture);
      const version = await versionRepo.load(versionId);
      expect<object | undefined>(version?.definitionJson).toEqual(
        fixture.definitionJson,
      );
    });
  }

  serialTest(
    "an unreadable version is skipped by list reads and throws on single reads",
    async () => {
      const graphId = await insertGraph(projectId);
      const readableId = await insertVersion(graphId, 1, v1WayfinderFixture);
      const unreadableId = await insertVersion(graphId, 2, unreadable);

      const listed = await versionRepo.listByGraphId(graphId);
      expect(listed.map((version) => version.id)).toEqual([readableId]);
      expect(
        await versionRepo.loadMany([readableId, unreadableId]),
      ).toHaveLength(1);

      expect(await rejectionOf(versionRepo.load(unreadableId))).toBeInstanceOf(
        PersistenceError,
      );
      expect(
        await rejectionOf(versionRepo.loadLatestByGraphId(graphId)),
      ).toBeInstanceOf(PersistenceError);
    },
  );

  serialTest(
    "a pipeline whose current version is unreadable still loads its handle",
    async () => {
      const graphId = await insertGraph(projectId);
      const versionId = await insertVersion(graphId, 1, unreadable);
      await getDb()
        .update(pipelineGraphs)
        .set({ currentVersionId: versionId })
        .where(eq(pipelineGraphs.id, graphId));

      const resolved = await graphRepo.load(graphId);
      expect(resolved?.handle.id).toBe(graphId);
      expect(resolved?.currentVersion).toBeNull();
    },
  );

  serialTest(
    "the task step key reader reads the step from the fixture row",
    async () => {
      const graphId = await insertGraph(projectId);
      const versionId = await insertVersion(graphId, 1, v1MultiNodeFixture);
      const workItem = await seedWorkItem({ projectId });
      const runId = await seedRun({
        projectId,
        pipeline: { id: graphId, versionId, name: "Stored compat" },
        workItemId: workItem.id,
        status: "active",
        minute: 0,
      });
      const taskId = await seedTask({
        projectId,
        workItemId: workItem.id,
        status: "running",
        minute: 0,
      });
      await seedVisit({
        runId,
        nodeId: "decide-release",
        nodeKind: "step",
        status: "active",
        taskId,
      });
      const taskRunId = await seedTaskRun({
        taskId,
        projectId,
        workItemId: workItem.id,
        status: "running",
      });

      expect(
        await new DrizzleTaskRunStepKeyReader().loadStepKey(taskRunId),
      ).toBe("decide-release");
    },
  );

  serialTest(
    "the JSON keys read from SQL resolve on the fixture row",
    async () => {
      const graphId = await insertGraph(projectId);
      const versionId = await insertVersion(graphId, 1, v1MultiNodeFixture);
      const node = (id: string) =>
        sql`gv.definition_json -> 'nodes' -> ${id}::text`;
      const result = await getDb().execute<{
        waitKind: string;
        waitFor: string;
        waitTitle: string;
        waitActions: unknown;
        failError: string;
        stepKey: string;
      }>(sql`
        select
          ${node("sign-off")} ->> 'kind' as "waitKind",
          ${node("sign-off")} ->> 'for' as "waitFor",
          ${node("sign-off")} ->> 'title' as "waitTitle",
          ${node("sign-off")} -> 'actions' as "waitActions",
          ${node("release-blocked")} ->> 'error' as "failError",
          ${node("prepare-release")} ->> 'step' as "stepKey"
        from app.pipeline_graph_versions gv
        where gv.id = ${versionId}
      `);
      const nodes = v1MultiNodeFixture.definitionJson.nodes;
      expect(result.rows[0]).toEqual({
        waitKind: "wait",
        waitFor: "decision",
        waitTitle: nodes["sign-off"].title,
        waitActions: nodes["sign-off"].actions,
        failError: nodes["release-blocked"].error,
        stepKey: nodes["prepare-release"].step,
      });
    },
  );
});
