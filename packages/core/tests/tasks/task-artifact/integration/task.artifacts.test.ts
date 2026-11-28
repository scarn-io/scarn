import { eq } from "drizzle-orm";
import { beforeAll, describe, expect } from "bun:test";
import { createApp } from "@scarn/api/app";
import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { createScarnTreaty } from "tests/treaty";
import { createAppContext } from "@/lib/di";
import { getDb } from "@/lib/db";
import { taskArtifacts } from "@/lib/db/schema";
import type { TimeProvider } from "@/lib/time-provider";
import type { ProjectContract } from "@/projects/project/contracts/project-contracts";
import type { ObjectStore } from "@/artifacts/object-store";
import { serialTest, unwrapAsync, unwrapStartedTaskAsync } from "tests/utils";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import { seedWorkItem } from "tests/lib/db/seed-task-prerequisites";

const buildStepDefinitionPayload = (projectId: UuidV7, key: string) => ({
  projectId,
  key,
  name: "Artifact step",
  description: "Reusable step for artifact upload tests",
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
// null), so we supply a minimal fake that mints a deterministic URL. This lets
// the integration test exercise the full mint-then-record happy path without a
// real S3/RustFS backend, through the live Elysia app + Postgres.
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

describe("task artifacts", () => {
  let currentTime = new Date("2026-05-01T12:00:00.000Z");
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
      email: `task-artifacts-${crypto.randomUUID()}@example.com`,
    });
    authHeaders = owner.authHeaders;
    project = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: "Task Artifacts Project",
          description: "Project for task artifact tests",
          gitUrl: "https://github.com/example/test-project.git",
        },
        { headers: { ...owner.authHeaders } },
      ),
    );
    const stepDefinition = await unwrapAsync(
      apiClient.api["step-definitions"].post(
        buildStepDefinitionPayload(
          parseUuidV7(project.id),
          `artifact_step_${crypto.randomUUID()}`,
        ),
        { headers: { ...owner.authHeaders } },
      ),
    );
    stepDefinitionId = stepDefinition.id;
  });

  serialTest(
    "mints an upload URL and records the artifact end to end",
    async () => {
      if (!project || !authHeaders || !stepDefinitionId) {
        throw new Error("Expected setup to complete");
      }
      currentTime = new Date("2026-05-01T12:00:00.000Z");
      const { taskRunId, claimToken } = await claimStep(
        apiClient,
        authHeaders,
        parseUuidV7(project.id),
        stepDefinitionId,
        "worker-artifact",
      );

      const relativeStorePath = "reports/summary.json";
      const upload = await unwrapAsync(
        apiClient.api["task-runs"]({ taskRunId: taskRunId })[
          "artifact-upload-url"
        ].post(
          { claimToken, relativeStorePath, contentType: "application/json" },
          { headers: { ...authHeaders } },
        ),
      );
      const expectedKey = `artifacts/${project.id}/${taskRunId}/${relativeStorePath}`;
      expect(upload.objectKey).toBe(expectedKey);
      expect(upload.uploadUrl).toBe(`https://store.test/put/${expectedKey}`);
      expect(upload.storeRef).toBe(`s3://artifacts-bucket/${expectedKey}`);
      expect(upload.expiresInSeconds).toBeGreaterThan(0);

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
      expect(recorded.taskRunId).toBe(taskRunId);
      expect(recorded.objectKey).toBe(expectedKey);
      expect(recorded.storeRef).toBe(`s3://artifacts-bucket/${expectedKey}`);
      expect(recorded.sizeBytes).toBe(2048);
    },
  );

  serialTest(
    "rejects an upload-url request with the wrong claim token",
    async () => {
      if (!project || !authHeaders || !stepDefinitionId) {
        throw new Error("Expected setup to complete");
      }
      currentTime = new Date("2026-05-01T12:10:00.000Z");
      const { taskRunId } = await claimStep(
        apiClient,
        authHeaders,
        parseUuidV7(project.id),
        stepDefinitionId,
        "worker-artifact-auth",
      );

      const response = await apiClient.api["task-runs"]({
        taskRunId: taskRunId,
      })["artifact-upload-url"].post(
        {
          claimToken: "not-the-real-claim-token",
          relativeStorePath: "reports/summary.json",
        },
        { headers: { ...authHeaders } },
      );
      expect(response.data).toBeNull();
      expect(response.error?.status).toBe(409);
      expect(response.error?.value).toMatchObject({
        code: "TASK_OWNERSHIP_CONFLICT",
      });
    },
  );

  serialTest(
    "rejects an artifacts record with a spoofed object key",
    async () => {
      if (!project || !authHeaders || !stepDefinitionId) {
        throw new Error("Expected setup to complete");
      }
      currentTime = new Date("2026-05-01T12:20:00.000Z");
      const { taskRunId, claimToken } = await claimStep(
        apiClient,
        authHeaders,
        parseUuidV7(project.id),
        stepDefinitionId,
        "worker-artifact-spoof",
      );

      const response = await apiClient.api["task-runs"]({
        taskRunId: taskRunId,
      }).artifacts.post(
        {
          claimToken,
          objectKey: "artifacts/spoofed/key.json",
          relativeStorePath: "reports/summary.json",
          sizeBytes: 10,
        },
        { headers: { ...authHeaders } },
      );
      expect(response.data).toBeNull();
      expect(response.error?.value).toMatchObject({
        code: "ARTIFACT_OBJECT_KEY_MISMATCH",
      });
    },
  );

  serialTest(
    "returns 410 for a download-url request on an expired artifact",
    async () => {
      if (!project || !authHeaders || !stepDefinitionId) {
        throw new Error("Expected setup to complete");
      }
      currentTime = new Date("2026-05-01T12:30:00.000Z");
      const { taskRunId, claimToken } = await claimStep(
        apiClient,
        authHeaders,
        parseUuidV7(project.id),
        stepDefinitionId,
        "worker-artifact-expired",
      );

      const relativeStorePath = "reports/summary.json";
      const upload = await unwrapAsync(
        apiClient.api["task-runs"]({ taskRunId: taskRunId })[
          "artifact-upload-url"
        ].post(
          { claimToken, relativeStorePath, contentType: "application/json" },
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

      // Simulate the artifact having aged past `STORAGE_RETENTION_DAYS`: a
      // direct, surgical update of just this row's expiry columns, rather
      // than driving `ArtifactRepo.clearExpiredArtifacts` with an advanced
      // `now`. The repo method sweeps the WHOLE table by `createdAt` (which is
      // set by the DB's own `now()` default, not this file's `currentTime`
      // closure), so calling it here would risk clearing unrelated artifact
      // rows written by other integration tests against this same shared
      // test-container database. Mirrors what that method sets nulled
      // (`objectKey`/`storeRef`/`sizeBytes`/`contentType`) — see
      // `drizzle-artifact-repo.test.ts` for the repo-level equivalent.
      await getDb()
        .update(taskArtifacts)
        .set({
          objectKey: null,
          storeRef: null,
          sizeBytes: null,
          contentType: null,
        })
        .where(eq(taskArtifacts.id, recorded.id));

      const response = await apiClient.api["task-runs"]({
        taskRunId: taskRunId,
      })
        .artifacts({ artifactId: recorded.id })
        ["download-url"].get({ headers: { ...authHeaders } });

      expect(response.data).toBeNull();
      expect(response.error?.status).toBe(410);
      expect(response.error?.value).toMatchObject({
        code: "ARTIFACT_EXPIRED",
      });
    },
  );
});
