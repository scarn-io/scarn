/* eslint max-lines: off */
import { eq } from "drizzle-orm";
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
import { taskArtifacts } from "@/lib/db/schema";
import type { TimeProvider } from "@/lib/time-provider";
import type { ProjectContract } from "@/projects/project/contracts/project-contracts";
import type { ObjectStore } from "@/artifacts/object-store";
import { InMemoryDomainEventDispatcher } from "@/lib/domain-events/in-memory-domain-event-dispatcher";
import type { DomainEventHandler } from "@/lib/domain-events/domain-event";
import {
  ARTIFACT_DELETED_DOMAIN_EVENT_TYPE,
  type ArtifactDeletedDomainEvent,
} from "@/tasks/task-artifact/domain/artifact-deleted.domain-event";
import { serialTest, unwrapAsync, unwrapStartedTaskAsync } from "tests/utils";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import { seedWorkItem } from "tests/lib/db/seed-task-prerequisites";

const buildStepDefinitionPayload = (projectId: UuidV7, key: string) => ({
  projectId,
  key,
  name: "Project artifacts delete step",
  description: "Reusable step for project-artifacts DELETE tests",
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

/** Records one real artifact end-to-end (upload-url mint + record) via HTTP. */
const recordArtifact = async (
  apiClient: ReturnType<typeof createScarnTreaty>,
  authHeaders: { authorization: string },
  projectId: UuidV7,
  stepDefinitionId: UuidV7,
  opts: { workerId: string; relativeStorePath: string; sizeBytes?: number },
): Promise<{ id: UuidV7; objectKey: string; taskRunId: UuidV7 }> => {
  const { taskRunId, claimToken } = await claimStep(
    apiClient,
    authHeaders,
    projectId,
    stepDefinitionId,
    opts.workerId,
  );
  const upload = await unwrapAsync(
    apiClient.api["task-runs"]({ taskRunId: taskRunId })[
      "artifact-upload-url"
    ].post(
      {
        claimToken,
        relativeStorePath: opts.relativeStorePath,
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
        relativeStorePath: opts.relativeStorePath,
        sizeBytes: opts.sizeBytes ?? 2048,
        contentType: "application/json",
      },
      { headers: { ...authHeaders } },
    ),
  );
  return { id: recorded.id, objectKey: upload.objectKey, taskRunId };
};

/**
 * An object store that mints deterministic presigned URLs (so upload-url +
 * record HTTP round-trips work end to end) and tracks every key passed to
 * `deleteObject` for later assertion.
 */
const trackingObjectStore = (): {
  store: ObjectStore;
  deletedKeys: string[];
} => {
  const deletedKeys: string[] = [];
  return {
    deletedKeys,
    store: {
      putObject: () => Promise.resolve({ sizeBytes: 0 }),
      getObject: () => Promise.resolve(null),
      getPresignedGetUrl: (key: string) =>
        Promise.resolve(`https://store.test/get/${key}`),
      getPresignedPutUrl: (key: string) =>
        Promise.resolve(`https://store.test/put/${key}`),
      deleteObject: (key: string) => {
        deletedKeys.push(key);
        return Promise.resolve();
      },
      deletePrefix: () => Promise.resolve({ deletedCount: 0 }),
    },
  };
};

/** An object store whose `deleteObject` always rejects (simulated S3 outage). */
const rejectingObjectStore = (): ObjectStore => ({
  putObject: () => Promise.resolve({ sizeBytes: 0 }),
  getObject: () => Promise.resolve(null),
  getPresignedGetUrl: (key: string) =>
    Promise.resolve(`https://store.test/get/${key}`),
  getPresignedPutUrl: (key: string) =>
    Promise.resolve(`https://store.test/put/${key}`),
  deleteObject: () => Promise.reject(new Error("simulated S3 outage")),
  deletePrefix: () => Promise.resolve({ deletedCount: 0 }),
});

describe("DELETE /projects/:projectId/artifacts", () => {
  const currentTime = new Date("2026-05-04T12:00:00.000Z");
  const timeProvider: TimeProvider = {
    now: () => currentTime,
    nowIso: () => currentTime.toISOString(),
  };

  let project: ProjectContract | undefined;
  let ownerAuthHeaders: { authorization: string } | undefined;
  let stepDefinitionId: UuidV7 | undefined;

  beforeAll(async () => {
    const app = createApp(createAppContext({ timeProvider }));
    const apiClient = createScarnTreaty(app);
    const owner = await createTestUserAndSession({
      email: `project-artifacts-delete-${crypto.randomUUID()}@example.com`,
    });
    ownerAuthHeaders = owner.authHeaders;
    project = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: "Project Artifacts DELETE Project",
          description: "Project for project-artifacts DELETE tests",
          gitUrl: "https://github.com/example/test-project.git",
        },
        { headers: { ...owner.authHeaders } },
      ),
    );
    const stepDefinition = await unwrapAsync(
      apiClient.api["step-definitions"].post(
        buildStepDefinitionPayload(
          parseUuidV7(project.id),
          `project_artifacts_delete_step_${crypto.randomUUID()}`,
        ),
        { headers: { ...owner.authHeaders } },
      ),
    );
    stepDefinitionId = stepDefinition.id;
  });

  serialTest(
    "returns 403 when the caller has a membership but lacks executions:write",
    async () => {
      if (!project || !ownerAuthHeaders) {
        throw new Error("Expected setup to complete");
      }
      const app = createApp(createAppContext({ timeProvider }));
      const apiClient = createScarnTreaty(app);
      const reader = await createTestUserAndSession({
        email: `project-artifacts-delete-reader-${crypto.randomUUID()}@example.com`,
      });
      await unwrapAsync(
        apiClient.api
          .projects({ projectId: project.id })
          .members({ userId: reader.userId })
          .role.put({ role: "read" }, { headers: { ...ownerAuthHeaders } }),
      );

      const { data, error } = await apiClient.api
        .projects({ projectId: project.id })
        .artifacts({ artifactId: createUuidV7() })
        .delete(undefined, { headers: { ...reader.authHeaders } });

      expect(data).toBeNull();
      expect(error?.status).toBe(403);
    },
  );

  serialTest("returns 404 for a cross-project artifact id (IDOR)", async () => {
    if (!project || !ownerAuthHeaders || !stepDefinitionId) {
      throw new Error("Expected setup to complete");
    }
    const app = createApp(
      createAppContext({
        timeProvider,
        objectStore: trackingObjectStore().store,
        objectStorageBucket: "artifacts-bucket",
      }),
    );
    const apiClient = createScarnTreaty(app);

    const artifact = await recordArtifact(
      apiClient,
      ownerAuthHeaders,
      parseUuidV7(project.id),
      stepDefinitionId,
      { workerId: "worker-idor", relativeStorePath: "reports/idor.json" },
    );

    const otherProject = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: "Project Artifacts DELETE IDOR Project",
          description: "Second project for the IDOR test",
          gitUrl: "https://github.com/example/test-project-idor.git",
        },
        { headers: { ...ownerAuthHeaders } },
      ),
    );

    const { data, error } = await apiClient.api
      .projects({ projectId: otherProject.id })
      .artifacts({ artifactId: artifact.id })
      .delete(undefined, { headers: { ...ownerAuthHeaders } });

    expect(data).toBeNull();
    expect(error?.status).toBe(404);
  });

  serialTest(
    "skips the S3 call and the billing event for an already-expired artifact, but still soft-deletes it",
    async () => {
      if (!project || !ownerAuthHeaders || !stepDefinitionId) {
        throw new Error("Expected setup to complete");
      }
      const dispatcher = new InMemoryDomainEventDispatcher();
      const seen: ArtifactDeletedDomainEvent[] = [];
      const handler: DomainEventHandler<ArtifactDeletedDomainEvent> = {
        handle: (event) => {
          seen.push(event);
          return Promise.resolve();
        },
      };
      dispatcher.register(ARTIFACT_DELETED_DOMAIN_EVENT_TYPE, handler);

      const { store, deletedKeys } = trackingObjectStore();
      const app = createApp(
        createAppContext({
          timeProvider,
          objectStore: store,
          objectStorageBucket: "artifacts-bucket",
          domainEventDispatcher: dispatcher,
        }),
      );
      const apiClient = createScarnTreaty(app);

      const artifact = await recordArtifact(
        apiClient,
        ownerAuthHeaders,
        parseUuidV7(project.id),
        stepDefinitionId,
        {
          workerId: "worker-expired",
          relativeStorePath: "reports/expired.json",
        },
      );

      // Simulate the artifact having aged past `STORAGE_RETENTION_DAYS`, same
      // technique as `task.artifacts.test.ts`'s expired-artifact
      // case: a direct, surgical update of just this row's expiry columns.
      await getDb()
        .update(taskArtifacts)
        .set({
          objectKey: null,
          storeRef: null,
          sizeBytes: null,
          contentType: null,
        })
        .where(eq(taskArtifacts.id, parseUuidV7(artifact.id)));

      const deletedCount = await unwrapAsync(
        apiClient.api
          .projects({ projectId: project.id })
          .artifacts({ artifactId: artifact.id })
          .delete(undefined, { headers: { ...ownerAuthHeaders } }),
      );

      expect(deletedCount).toBe(1);
      expect(deletedKeys).toEqual([]);
      expect(seen).toHaveLength(0);

      const [row] = await getDb()
        .select()
        .from(taskArtifacts)
        .where(eq(taskArtifacts.id, parseUuidV7(artifact.id)));
      expect(row?.deletedAt).not.toBeNull();
    },
  );

  serialTest(
    "deletes a live artifact: calls objectStore.deleteObject with its key, soft-deletes it, and emits ArtifactDeletedDomainEvent with the pre-nulling sizeBytes",
    async () => {
      if (!project || !ownerAuthHeaders || !stepDefinitionId) {
        throw new Error("Expected setup to complete");
      }
      const dispatcher = new InMemoryDomainEventDispatcher();
      const seen: ArtifactDeletedDomainEvent[] = [];
      const handler: DomainEventHandler<ArtifactDeletedDomainEvent> = {
        handle: (event) => {
          seen.push(event);
          return Promise.resolve();
        },
      };
      dispatcher.register(ARTIFACT_DELETED_DOMAIN_EVENT_TYPE, handler);

      const { store, deletedKeys } = trackingObjectStore();
      const app = createApp(
        createAppContext({
          timeProvider,
          objectStore: store,
          objectStorageBucket: "artifacts-bucket",
          domainEventDispatcher: dispatcher,
        }),
      );
      const apiClient = createScarnTreaty(app);

      const artifact = await recordArtifact(
        apiClient,
        ownerAuthHeaders,
        parseUuidV7(project.id),
        stepDefinitionId,
        {
          workerId: "worker-live-delete",
          relativeStorePath: "reports/live.json",
          sizeBytes: 4096,
        },
      );

      const deletedCount = await unwrapAsync(
        apiClient.api
          .projects({ projectId: project.id })
          .artifacts({ artifactId: artifact.id })
          .delete(undefined, { headers: { ...ownerAuthHeaders } }),
      );

      expect(deletedCount).toBe(1);
      expect(deletedKeys).toEqual([artifact.objectKey]);

      const [row] = await getDb()
        .select()
        .from(taskArtifacts)
        .where(eq(taskArtifacts.id, parseUuidV7(artifact.id)));
      expect(row?.deletedAt).not.toBeNull();
      expect(row?.objectKey).toBeNull();
      expect(row?.storeRef).toBeNull();
      expect(row?.sizeBytes).toBeNull();
      expect(row?.contentType).toBeNull();

      expect(seen).toHaveLength(1);
      expect(seen[0]?.payload.artifactId).toBe(parseUuidV7(artifact.id));
      expect(seen[0]?.payload.sizeBytes).toBe(4096);
    },
  );

  serialTest(
    "still soft-deletes when objectStore.deleteObject rejects (S3 failure is swallowed)",
    async () => {
      if (!project || !ownerAuthHeaders || !stepDefinitionId) {
        throw new Error("Expected setup to complete");
      }
      const app = createApp(
        createAppContext({
          timeProvider,
          objectStore: rejectingObjectStore(),
          objectStorageBucket: "artifacts-bucket",
        }),
      );
      const apiClient = createScarnTreaty(app);

      const artifact = await recordArtifact(
        apiClient,
        ownerAuthHeaders,
        parseUuidV7(project.id),
        stepDefinitionId,
        {
          workerId: "worker-s3-failure",
          relativeStorePath: "reports/s3-failure.json",
        },
      );

      const deletedCount = await unwrapAsync(
        apiClient.api
          .projects({ projectId: project.id })
          .artifacts({ artifactId: artifact.id })
          .delete(undefined, { headers: { ...ownerAuthHeaders } }),
      );

      expect(deletedCount).toBe(1);

      const [row] = await getDb()
        .select()
        .from(taskArtifacts)
        .where(eq(taskArtifacts.id, parseUuidV7(artifact.id)));
      expect(row?.deletedAt).not.toBeNull();
    },
  );

  serialTest("batch-deletes two live artifacts in one call", async () => {
    if (!project || !ownerAuthHeaders || !stepDefinitionId) {
      throw new Error("Expected setup to complete");
    }
    const { store } = trackingObjectStore();
    const app = createApp(
      createAppContext({
        timeProvider,
        objectStore: store,
        objectStorageBucket: "artifacts-bucket",
      }),
    );
    const apiClient = createScarnTreaty(app);

    const first = await recordArtifact(
      apiClient,
      ownerAuthHeaders,
      parseUuidV7(project.id),
      stepDefinitionId,
      { workerId: "worker-batch-1", relativeStorePath: "reports/batch-1.json" },
    );
    const second = await recordArtifact(
      apiClient,
      ownerAuthHeaders,
      parseUuidV7(project.id),
      stepDefinitionId,
      { workerId: "worker-batch-2", relativeStorePath: "reports/batch-2.json" },
    );

    const deletedCount = await unwrapAsync(
      apiClient.api
        .projects({ projectId: project.id })
        .artifacts.batch.delete(
          { input: [first.id, second.id] },
          { headers: { ...ownerAuthHeaders } },
        ),
    );

    expect(deletedCount).toBe(2);

    const listing = await unwrapAsync(
      apiClient.api
        .projects({ projectId: project.id })
        .artifacts.get({ headers: { ...ownerAuthHeaders } }),
    );
    const remainingIds = listing.artifacts.map((a) => a.id);
    expect(remainingIds).not.toContain(first.id);
    expect(remainingIds).not.toContain(second.id);
  });
});
