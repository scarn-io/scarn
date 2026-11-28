import { beforeAll, describe, expect } from "bun:test";
import { createApp } from "@scarn/api/app";
import {
  createUuidV7,
  parseUuidV7,
  type UuidV7,
} from "@scarn/core/common/contracts/uuid-v7";
import { createScarnTreaty } from "tests/treaty";
import { createAppContext } from "@/lib/di";
import { getDb } from "@/lib/db";
import { taskArtifacts, taskRuns } from "@/lib/db/schema";
import type { TimeProvider } from "@/lib/time-provider";
import type { ProjectContract } from "@/projects/project/contracts/project-contracts";
import type { ObjectStore } from "@/artifacts/object-store";
import {
  concurrentTest,
  unwrapAsync,
  unwrapStartedTaskAsync,
} from "tests/utils";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import {
  seedTaskRunParent,
  seedTaskPrerequisites,
  seedWorkItem,
} from "tests/lib/db/seed-task-prerequisites";

const buildStepDefinitionPayload = (projectId: UuidV7, key: string) => ({
  projectId,
  key,
  name: "Project artifacts step",
  description: "Reusable step for project-artifacts GET tests",
  prompt: "Return a result payload.",
  version: 1,
  kind: "user_defined" as const,
  inputSchemaJson: { type: "object" },
  resultSchemaJson: { type: "object" },
  status: "active" as const,
});

const claimStep = async (
  apiClient: ReturnType<typeof createScarnTreaty>,
  authHeaders: { authorization: string },
  projectId: UuidV7,
  stepDefinitionId: UuidV7,
  workerId: string,
): Promise<{ taskRunId: UuidV7; claimToken: string }> => {
  const { run: task } = await unwrapStartedTaskAsync(
    apiClient.api.tasks.post(
      {
        projectId,
        workItemId: await seedWorkItem(projectId),
        stepDefinitionId,
        stepDefinitionVersion: 1,
        inputJson: { ticketId: `ticket-${workerId}` },
        executionTimeoutSeconds: 300,
      },
      { headers: { ...authHeaders } },
    ),
  );
  const claims = await unwrapAsync(
    apiClient.api["task-runs"].claims.post(
      { projectId, workerId, batchSize: 1, leaseDurationSeconds: 30 },
      { headers: { ...authHeaders } },
    ),
  );
  const claimToken = claims[0]?.claimToken;
  if (!claimToken) {
    throw new Error("Expected claim token to be returned");
  }
  return { taskRunId: task.id, claimToken };
};

// A presign-capable object store: the in-memory store cannot presign (returns
// null), so we supply a minimal fake that mints a deterministic URL. Mirrors
// `task.artifacts.test.ts`.
const presigningObjectStore = (): ObjectStore => ({
  putObject: () => Promise.resolve({ sizeBytes: 0 }),
  getObject: () => Promise.resolve(null),
  getObjectStream: () => Promise.resolve(null),
  getPresignedGetUrl: (key: string) =>
    Promise.resolve(`https://store.test/get/${key}`),
  getPresignedPutUrl: (key: string) =>
    Promise.resolve(`https://store.test/put/${key}`),
  deleteObject: () => Promise.resolve(),
  deletePrefix: () => Promise.resolve({ deletedCount: 0 }),
});

/**
 * Bulk-seeds `count` artifacts (plus their backing task runs) directly
 * via Drizzle under an already-created project — the GET
 * route under test doesn't care how the rows got there, only that they exist
 * with the right `projectId`/`deletedAt`; driving 51 sequential HTTP
 * upload-url + record round-trips per test would be needlessly slow. Mirrors
 * `drizzle-artifact-repo.test.ts`'s `seedArtifactsBulk`.
 */
const seedArtifactsDirectly = async (
  projectId: UuidV7,
  count: number,
  baseTime: Date,
): Promise<void> => {
  const db = getDb();
  const { workItemId } = await seedTaskPrerequisites(projectId, db);
  const taskIds = Array.from({ length: count }, () => createUuidV7());
  const parent = await seedTaskRunParent({ projectId, workItemId }, db);
  await db.insert(taskRuns).values(
    taskIds.map((id, index) => ({
      id,
      projectId,
      workItemId,
      ...parent,
      number: index + 1,
      status: "succeeded" as const,
    })),
  );
  await db.insert(taskArtifacts).values(
    taskIds.map((taskRunId, index) => {
      const objectKey = `artifacts/${projectId}/${taskRunId}/reports/summary.json`;
      return {
        id: createUuidV7(),
        taskRunId: taskRunId,
        projectId,
        relativeStorePath: "reports/summary.json",
        objectKey,
        storeRef: `s3://bucket/${objectKey}`,
        sizeBytes: 2048,
        contentType: "application/json",
        createdAt: new Date(baseTime.getTime() + index * 1_000),
      };
    }),
  );
};

describe("GET /projects/:projectId/artifacts", () => {
  let currentTime = new Date("2026-05-02T12:00:00.000Z");
  const timeProvider: TimeProvider = {
    now: () => currentTime,
    nowIso: () => currentTime.toISOString(),
  };
  const app = createApp(
    createAppContext({
      timeProvider,
      objectStore: presigningObjectStore(),
      objectStorageBucket: "artifacts-bucket",
    }),
  );
  const apiClient = createScarnTreaty(app);
  let project: ProjectContract | undefined;
  let authHeaders: { authorization: string } | undefined;
  let stepDefinitionId: UuidV7 | undefined;

  beforeAll(async () => {
    const owner = await createTestUserAndSession({
      email: `project-artifacts-get-${crypto.randomUUID()}@example.com`,
    });
    authHeaders = owner.authHeaders;
    project = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: "Project Artifacts GET Project",
          description: "Project for project-artifacts GET tests",
          gitUrl: "https://github.com/example/test-project.git",
        },
        { headers: { ...owner.authHeaders } },
      ),
    );
    const stepDefinition = await unwrapAsync(
      apiClient.api["step-definitions"].post(
        buildStepDefinitionPayload(
          parseUuidV7(project.id),
          `project_artifacts_get_step_${crypto.randomUUID()}`,
        ),
        { headers: { ...owner.authHeaders } },
      ),
    );
    stepDefinitionId = stepDefinition.id;
  });

  concurrentTest(
    "returns 401 when the request is unauthenticated",
    async () => {
      if (!project) {
        throw new Error("Expected setup to complete");
      }
      const { data, error } = await apiClient.api
        .projects({ projectId: project.id })
        .artifacts.get();

      expect(data).toBeNull();
      expect(error?.status).toBe(401);
    },
  );

  concurrentTest(
    "returns 403 for an authenticated caller with no project membership",
    async () => {
      if (!project) {
        throw new Error("Expected setup to complete");
      }
      const nonMember = await createTestUserAndSession({
        email: `project-artifacts-get-non-member-${crypto.randomUUID()}@example.com`,
      });

      const { data, error } = await apiClient.api
        .projects({ projectId: project.id })
        .artifacts.get({ headers: { ...nonMember.authHeaders } });

      expect(data).toBeNull();
      expect(error?.status).toBe(403);
    },
  );

  concurrentTest(
    "lists recorded artifacts newest-first with a nodeKey field, hasMore false under the cap",
    async () => {
      if (!project || !authHeaders || !stepDefinitionId) {
        throw new Error("Expected setup to complete");
      }
      currentTime = new Date("2026-05-02T12:10:00.000Z");
      const { taskRunId, claimToken } = await claimStep(
        apiClient,
        authHeaders,
        parseUuidV7(project.id),
        stepDefinitionId,
        "worker-project-artifacts-get",
      );

      const recordedIds: UuidV7[] = [];
      for (const relativeStorePath of [
        "reports/first.json",
        "reports/second.json",
      ]) {
        const upload = await unwrapAsync(
          apiClient.api["task-runs"]({ taskRunId: taskRunId })[
            "artifact-upload-url"
          ].post(
            {
              claimToken,
              relativeStorePath,
              contentType: "application/json",
            },
            { headers: { ...authHeaders } },
          ),
        );
        const recorded = await unwrapAsync(
          apiClient.api["task-runs"]({ taskRunId: taskRunId }).artifacts.post(
            {
              claimToken,
              objectKey: upload.objectKey,
              relativeStorePath,
              sizeBytes: 2048,
              contentType: "application/json",
            },
            { headers: { ...authHeaders } },
          ),
        );
        recordedIds.push(recorded.id);
      }

      const response = await unwrapAsync(
        apiClient.api
          .projects({ projectId: project.id })
          .artifacts.get({ headers: { ...authHeaders } }),
      );

      expect(response.hasMore).toBe(false);
      const orderedRecordedIds = [...recordedIds].reverse();
      const listedIds = response.artifacts
        .filter((artifact) => orderedRecordedIds.includes(artifact.id))
        .map((artifact) => artifact.id);
      expect(listedIds).toEqual(orderedRecordedIds);
      for (const artifact of response.artifacts) {
        expect(artifact).toHaveProperty("nodeKey");
      }
    },
  );

  concurrentTest(
    "caps the list at 50 and reports hasMore when more than 50 exist",
    async () => {
      if (!project || !stepDefinitionId || !authHeaders) {
        throw new Error("Expected setup to complete");
      }
      const hasMoreOwner = await createTestUserAndSession({
        email: `project-artifacts-get-hasmore-${crypto.randomUUID()}@example.com`,
      });
      const hasMoreProject = await unwrapAsync(
        apiClient.api.projects.post(
          {
            name: "Project Artifacts hasMore Project",
            description: "Project for the hasMore boundary test",
            gitUrl: "https://github.com/example/test-project-hasmore.git",
          },
          { headers: { ...hasMoreOwner.authHeaders } },
        ),
      );
      await seedArtifactsDirectly(
        parseUuidV7(hasMoreProject.id),
        51,
        new Date("2026-05-03T00:00:00.000Z"),
      );

      const response = await unwrapAsync(
        apiClient.api
          .projects({ projectId: hasMoreProject.id })
          .artifacts.get({ headers: { ...hasMoreOwner.authHeaders } }),
      );

      expect(response.hasMore).toBe(true);
      expect(response.artifacts.length).toBe(50);
    },
  );
});
