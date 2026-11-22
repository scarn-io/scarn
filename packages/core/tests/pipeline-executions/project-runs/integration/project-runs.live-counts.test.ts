import { beforeAll, describe, expect } from "bun:test";
import { eq } from "drizzle-orm";
import {
  createUuidV7,
  type UuidV7,
} from "@scarn/core/common/contracts/uuid-v7";
import type { PipelineLiveCountsContract } from "@scarn/core/pipeline-executions/project-runs/contracts/project-runs-contracts";
import { getDb } from "@/lib/db";
import { laneGroups, lanes, nodeVisits, pipelineRuns } from "@/lib/db/schema";
import { concurrentTest, unwrapAsync } from "tests/utils";
import {
  apiClient,
  createOutsider,
  createRunsProject,
  markProjectPublic,
  seedPipeline,
  seedRun,
  seedTask,
  seedTaskRun,
  seedVisit,
  seedWorkItem,
  type RunsProject,
  type Viewer,
} from "./project-runs-test-support";

const DAY_MS = 24 * 60 * 60 * 1000;

const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS);

const getLiveCounts = (viewer: Viewer, projectId: UuidV7) =>
  apiClient.api
    .projects({ projectId })
    ["pipeline-definitions"]["live-counts"].get({
      headers: viewer ? { ...viewer.authHeaders } : {},
    });

const liveCounts = async (
  viewer: Viewer,
  projectId: UuidV7,
): Promise<PipelineLiveCountsContract> =>
  await unwrapAsync(getLiveCounts(viewer, projectId));

const finishedAt = async (runId: UuidV7, completedAt: Date) => {
  await getDb()
    .update(pipelineRuns)
    .set({ completedAt, updatedAt: completedAt })
    .where(eq(pipelineRuns.id, runId));
};

/** Two open lanes of one `each` split, both at `nodeId`. */
const seedFanOut = async (runId: UuidV7, nodeId: string) => {
  const splitVisitId = await seedVisit({
    runId,
    nodeId: "build",
    nodeKind: "step",
    status: "succeeded",
  });
  const groupId = createUuidV7();
  await getDb().insert(laneGroups).values({
    id: groupId,
    pipelineRunId: runId,
    spawnedByVisitId: splitVisitId,
    kind: "each",
    laneCount: 2,
    toleratedFailuresJson: {},
    status: "open",
  });
  for (const index of [0, 1]) {
    const laneId = createUuidV7();
    await getDb().insert(lanes).values({
      id: laneId,
      laneGroupId: groupId,
      index,
      routeJson: {},
      origin: "split",
      status: "active",
    });
    const visitId = await seedVisit({
      runId,
      nodeId,
      nodeKind: "step",
      status: "active",
    });
    await getDb()
      .update(nodeVisits)
      .set({ laneId, fromVisitId: splitVisitId })
      .where(eq(nodeVisits.id, visitId));
  }
};

type Seeded = {
  review: Awaited<ReturnType<typeof seedPipeline>>;
  idle: Awaited<ReturnType<typeof seedPipeline>>;
};

const seedLiveCases = async (project: RunsProject): Promise<Seeded> => {
  const { projectId } = project;
  const review = await seedPipeline(projectId, "Review");
  const idle = await seedPipeline(projectId, "Idle");
  const workItemId = (await seedWorkItem({ projectId })).id;
  const run = (
    status: Parameters<typeof seedRun>[0]["status"],
    endNodeId: string | null = null,
  ) =>
    seedRun({
      projectId,
      pipeline: review,
      workItemId,
      status,
      minute: 0,
      endNodeId,
    });

  const running = await run("active");
  const taskId = await seedTask({
    projectId,
    workItemId,
    status: "running",
    minute: 0,
  });
  await seedTaskRun({ taskId, projectId, workItemId, status: "running" });
  await seedVisit({
    runId: running,
    nodeId: "build",
    nodeKind: "step",
    status: "active",
    taskId,
  });

  const queued = await run("active");
  await seedVisit({
    runId: queued,
    nodeId: "build",
    nodeKind: "step",
    status: "active",
  });

  const waiting = await run("waiting");
  await seedVisit({
    runId: waiting,
    nodeId: "build",
    nodeKind: "step",
    status: "succeeded",
  });
  await seedVisit({
    runId: waiting,
    nodeId: "ask",
    nodeKind: "wait",
    status: "waiting",
  });

  const fanOut = await run("active");
  await seedFanOut(fanOut, "lint");
  await seedVisit({
    runId: fanOut,
    nodeId: "lint",
    nodeKind: "step",
    status: "failed",
  });

  const caught = await run("active");
  const caughtVisit = await seedVisit({
    runId: caught,
    nodeId: "lint",
    nodeKind: "step",
    status: "failed",
  });
  const recovery = await seedVisit({
    runId: caught,
    nodeId: "ask",
    nodeKind: "wait",
    status: "waiting",
  });
  await getDb()
    .update(nodeVisits)
    .set({ fromVisitId: caughtVisit })
    .where(eq(nodeVisits.id, recovery));

  const crashed = await run("failed");
  await seedVisit({
    runId: crashed,
    nodeId: "build",
    nodeKind: "step",
    status: "failed",
  });
  await finishedAt(crashed, daysAgo(1));

  const oldCrash = await run("failed");
  await seedVisit({
    runId: oldCrash,
    nodeId: "build",
    nodeKind: "step",
    status: "failed",
  });
  await finishedAt(oldCrash, daysAgo(10));

  const ended = await run("failed", "rejected");
  await seedVisit({
    runId: ended,
    nodeId: "rejected",
    nodeKind: "fail",
    status: "failed",
  });
  await finishedAt(ended, daysAgo(1));

  await finishedAt(await run("succeeded"), daysAgo(2));
  await finishedAt(await run("succeeded"), daysAgo(6));
  await finishedAt(await run("succeeded"), daysAgo(9));

  const cancelled = await run("cancelled");
  await seedVisit({
    runId: cancelled,
    nodeId: "build",
    nodeKind: "step",
    status: "cancelled",
  });

  return { review, idle };
};

const pipelineOf = (counts: PipelineLiveCountsContract, id: UuidV7) => {
  const pipeline = counts.pipelines.find(
    (entry) => entry.pipelineDefinitionId === id,
  );
  if (!pipeline) {
    throw new Error(`No live counts for pipeline ${id}`);
  }
  return pipeline;
};

/** `GET /projects/:projectId/pipeline-definitions/live-counts`. */
describe("project runs: pipeline live counts", () => {
  let project: RunsProject;
  let seeded: Seeded;
  let other: RunsProject;

  beforeAll(async () => {
    [project, other] = await Promise.all([
      createRunsProject(),
      createRunsProject(),
    ]);
    await markProjectPublic(project.projectId);
    seeded = await seedLiveCases(project);
    await seedLiveCases(other);
  });

  concurrentTest(
    "counts in-progress runs and runs done in the last 7 days",
    async () => {
      const counts = await liveCounts(project.member, project.projectId);
      expect(counts.pipelines).toHaveLength(2);
      expect(pipelineOf(counts, seeded.review.id)).toMatchObject({
        inProgress: 5,
        doneThisWeek: 2,
      });
      expect(pipelineOf(counts, seeded.idle.id)).toEqual({
        pipelineDefinitionId: seeded.idle.id,
        inProgress: 0,
        doneThisWeek: 0,
        nodes: {},
      });
    },
  );

  concurrentTest(
    "counts open visits, fan-out lanes and uncaught failures per node",
    async () => {
      const { nodes } = pipelineOf(
        await liveCounts(project.member, project.projectId),
        seeded.review.id,
      );
      expect(nodes).toEqual({
        build: { running: 2, waiting: 0, failed: 1, lanes: 0 },
        ask: { running: 0, waiting: 2, failed: 0, lanes: 0 },
        lint: { running: 2, waiting: 0, failed: 1, lanes: 2 },
      });
    },
  );

  concurrentTest("excludes another project's pipelines", async () => {
    const counts = await liveCounts(project.member, project.projectId);
    const otherCounts = await liveCounts(other.owner, other.projectId);
    const ids = new Set(counts.pipelines.map((p) => p.pipelineDefinitionId));
    for (const pipeline of otherCounts.pipelines) {
      expect(ids.has(pipeline.pipelineDefinitionId)).toBe(false);
    }
  });

  concurrentTest("a public project's guests read it", async () => {
    const outsider = await createOutsider();
    const asMember = await liveCounts(project.member, project.projectId);
    expect(await liveCounts(outsider, project.projectId)).toEqual(asMember);
    expect(await liveCounts(null, project.projectId)).toEqual(asMember);
  });

  concurrentTest("a non-member of a private project is refused", async () => {
    const outsider = await createOutsider();
    const { error } = await getLiveCounts(outsider, other.projectId);
    expect(error?.status).toBe(403);
    const anonymous = await getLiveCounts(null, other.projectId);
    expect(anonymous.error?.status).toBe(401);
  });

  concurrentTest("an unknown project is not found", async () => {
    const { error } = await getLiveCounts(project.owner, createUuidV7());
    expect(error?.status).toBe(404);
  });
});
