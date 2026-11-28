import { describe, expect, vi } from "bun:test";
import { createUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import {
  ArtifactExpiredError,
  ResourceNotFoundError,
  UsageLimitExceededError,
} from "@/lib/errors";
import { concurrentTest, fixedTimeProvider } from "tests/utils";
import { InMemoryDomainEventDispatcher } from "@/lib/domain-events/in-memory-domain-event-dispatcher";
import type { DomainEventHandler } from "@/lib/domain-events/domain-event";
import { getArtifactDownloadUrl } from "@/tasks/task-artifact/application/get-artifact-download-url";
import { TaskRunEntity } from "@/tasks/task-run/domain/task-run-entity";
import type { ArtifactRepo } from "@/tasks/task-artifact/application/artifact-repo";
import type { TaskRunRepo } from "@/tasks/task-run/application/task-run-repo";
import type { ArtifactContract } from "@/tasks/task-artifact/contracts/task-artifact-contracts";
import type { ObjectStore } from "@/artifacts/object-store";
import type { OrgRepo } from "@/organizations/organization/application/org-repo";
import type { OrganizationEntity } from "@/organizations/organization/domain/organization-entity";
import type { UsageMeterRepo } from "@/billing/usage-meter/application/usage-meter-repo";
import { UsageMeter } from "@/billing/usage-meter/domain/usage-meter-entity";
import {
  LOG_ARCHIVE_RETRIEVED_DOMAIN_EVENT_TYPE,
  type LogArchiveRetrievedDomainEvent,
} from "@/tasks/task-log/domain/log-archive-retrieved.domain-event";
import type { UserAuthorizationService } from "@/access/authorization/application/user-authorization-service";

const NOW = new Date("2026-05-01T12:00:00.000Z");
const PRESIGNED_URL = "https://store.example/download?sig=abc";
const OBJECT_KEY = "artifacts/proj/step/reports/out.json";
const ARTIFACT_SIZE_BYTES = 4096;

type FakeExecutor = {
  transaction: <T>(cb: (tx: FakeExecutor) => Promise<T>) => Promise<T>;
};
const fakeDbExecutor = () => {
  const executor: FakeExecutor = {
    transaction: (cb) => cb(executor),
  };
  return executor as never;
};

const runningStep = (): TaskRunEntity =>
  TaskRunEntity.rehydrate({
    id: createUuidV7(),
    taskId: createUuidV7(),
    number: 1,
    reason: "initial",
    projectId: createUuidV7(),
    workItemId: createUuidV7(),
    taskExecutionConfigId: createUuidV7(),
    kind: "agent",
    prompt: "Return a result payload.",
    status: "running",
    evaluatedAt: NOW,
    claimedBy: "worker-a",
    claimToken: "claim-token",
    claimedAt: NOW,
    leaseExpiresAt: new Date(NOW.getTime() + 60_000),
    startedAt: NOW,
  });

const fakeAuthz = (
  isPublicNonMemberGrant = false,
): UserAuthorizationService => ({
  actorId: createUuidV7(),
  requireProjectMember: () =>
    Promise.reject(new Error("requireProjectMember is not used here")),
  requireProjectPermission: vi.fn(() =>
    Promise.resolve({ membership: null, isPublicNonMemberGrant }),
  ),
});

const fakeStepRepo = (task: TaskRunEntity | null): TaskRunRepo =>
  ({
    load: vi.fn(() => Promise.resolve(task)),
  }) as unknown as TaskRunRepo;

const anArtifact = (
  taskRunId: UuidV7,
  overrides: Partial<ArtifactContract> = {},
): ArtifactContract => ({
  id: createUuidV7(),
  taskRunId,
  projectId: createUuidV7(),
  relativeStorePath: "reports/out.json",
  storeRef: "s3://bucket/artifacts/key.json",
  objectKey: OBJECT_KEY,
  sizeBytes: ARTIFACT_SIZE_BYTES,
  contentType: "application/json",
  kind: "generic",
  createdAt: NOW.toISOString(),
  bundleId: null,
  ...overrides,
});

const fakeArtifactRepo = (artifact: ArtifactContract | null): ArtifactRepo => ({
  findById: vi.fn(() => Promise.resolve(artifact)),
  listByTask: () => Promise.resolve([]),
  findWithRunContextById: () => Promise.resolve(null),
  listByProjectId: () => Promise.resolve([]),
  findManyByIds: () => Promise.resolve([]),
  softDeleteMany: () => Promise.resolve([]),
  record: () => Promise.reject(new Error("not used")),
  clearExpiredArtifacts: () => Promise.reject(new Error("not used")),
});

const fakeObjectStore = (
  url: string | null,
): { store: ObjectStore; presignKeys: string[] } => {
  const presignKeys: string[] = [];
  return {
    presignKeys,
    store: {
      getPresignedGetUrl: (key: string) => {
        presignKeys.push(key);
        return Promise.resolve(url);
      },
      getPresignedPutUrl: () => Promise.resolve(null),
      getObject: () => Promise.resolve(null),
      getObjectStream: () => Promise.resolve(null),
      putObject: () => Promise.resolve({ sizeBytes: 0 }),
      deleteObject: () => Promise.resolve(),
      deletePrefix: () => Promise.resolve({ deletedCount: 0 }),
    },
  };
};

const fakeOrgRepo = (orgId: UuidV7): OrgRepo =>
  ({
    findByProjectId: vi.fn(() =>
      Promise.resolve({ id: orgId } as unknown as OrganizationEntity),
    ),
  }) as unknown as OrgRepo;

/** A usage-meter repo whose meter is at/over the read cap (3000 reads). */
const overCapUsageMeterRepo = (orgId: UuidV7): UsageMeterRepo =>
  ({
    loadOrStart: vi.fn(() =>
      Promise.resolve(
        UsageMeter.rehydrate({
          orgId,
          period: "2026-05",
          planId: "free",
          writes: 0,
          reads: 3000,
          storageBytes: 0,
          signalTokens: 0,
        }),
      ),
    ),
  }) as unknown as UsageMeterRepo;

/** A usage-meter repo with plenty of read headroom. */
const withHeadroomUsageMeterRepo = (orgId: UuidV7): UsageMeterRepo =>
  ({
    loadOrStart: vi.fn(() =>
      Promise.resolve(UsageMeter.startPeriod(orgId, "2026-05", "free")),
    ),
  }) as unknown as UsageMeterRepo;

describe("getArtifactDownloadUrl", () => {
  concurrentTest(
    "happy path mints a presigned URL and returns artifact metadata",
    async () => {
      const step = runningStep();
      const artifact = anArtifact(step.id);
      const { store, presignKeys } = fakeObjectStore(PRESIGNED_URL);
      const userAuthz = fakeAuthz();

      const result = await getArtifactDownloadUrl(step.id, artifact.id, {
        userAuthz,
        taskRunRepo: fakeStepRepo(step),
        artifactRepo: fakeArtifactRepo(artifact),
        objectStore: store,
        timeProvider: fixedTimeProvider(NOW),
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toEqual({
        url: PRESIGNED_URL,
        sizeBytes: ARTIFACT_SIZE_BYTES,
        contentType: artifact.contentType,
        relativeStorePath: artifact.relativeStorePath,
      });
      expect(presignKeys).toEqual([OBJECT_KEY]);
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(userAuthz.requireProjectPermission).toHaveBeenCalledWith({
        projectId: step.projectId,
        permission: "executions:read",
      });
    },
  );

  concurrentTest(
    "returns an ArtifactExpiredError (410) err Result when the artifact has expired",
    async () => {
      // An expired artifact has had its storeRef/objectKey nulled by
      // `clearExpiredArtifacts` (Phase 2). This is distinct from a missing/
      // IDOR'd artifact — the row still exists — so it gets its own 410
      // result (Phase 3) rather than reusing the 404 above.
      const step = runningStep();
      const artifact = anArtifact(step.id, {
        storeRef: null,
        objectKey: null,
        sizeBytes: null,
        contentType: null,
      });
      const { store, presignKeys } = fakeObjectStore(PRESIGNED_URL);

      const result = await getArtifactDownloadUrl(step.id, artifact.id, {
        userAuthz: fakeAuthz(),
        taskRunRepo: fakeStepRepo(step),
        artifactRepo: fakeArtifactRepo(artifact),
        objectStore: store,
        timeProvider: fixedTimeProvider(NOW),
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBeInstanceOf(ArtifactExpiredError);
      expect(result.error.status).toBe(410);
      expect(presignKeys).toEqual([]);
    },
  );

  concurrentTest(
    "returns a ResourceNotFoundError err Result when the step is missing",
    async () => {
      const step = runningStep();
      const { store } = fakeObjectStore(PRESIGNED_URL);

      const result = await getArtifactDownloadUrl(step.id, createUuidV7(), {
        userAuthz: fakeAuthz(),
        taskRunRepo: fakeStepRepo(null),
        artifactRepo: fakeArtifactRepo(null),
        objectStore: store,
        timeProvider: fixedTimeProvider(NOW),
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBeInstanceOf(ResourceNotFoundError);
    },
  );

  concurrentTest(
    "returns a ResourceNotFoundError(Artifact) when the artifact is missing",
    async () => {
      const step = runningStep();
      const { store } = fakeObjectStore(PRESIGNED_URL);

      const result = await getArtifactDownloadUrl(step.id, createUuidV7(), {
        userAuthz: fakeAuthz(),
        taskRunRepo: fakeStepRepo(step),
        artifactRepo: fakeArtifactRepo(null),
        objectStore: store,
        timeProvider: fixedTimeProvider(NOW),
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBeInstanceOf(ResourceNotFoundError);
      expect(result.error.message).toContain("Artifact");
    },
  );

  concurrentTest(
    "IDOR guard: artifact belonging to another task is not leaked",
    async () => {
      const step = runningStep();
      const otherStepId = createUuidV7();
      // artifact exists but points at a DIFFERENT task
      const artifact = anArtifact(otherStepId);
      const { store, presignKeys } = fakeObjectStore(PRESIGNED_URL);

      const result = await getArtifactDownloadUrl(step.id, artifact.id, {
        userAuthz: fakeAuthz(),
        taskRunRepo: fakeStepRepo(step),
        artifactRepo: fakeArtifactRepo(artifact),
        objectStore: store,
        timeProvider: fixedTimeProvider(NOW),
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBeInstanceOf(ResourceNotFoundError);
      expect(result.error.message).toContain("Artifact");
      // never presigned — the mismatched artifact is not disclosed
      expect(presignKeys).toEqual([]);
    },
  );

  concurrentTest(
    "returns a ResourceNotFoundError when the object store is null",
    async () => {
      const step = runningStep();
      const artifact = anArtifact(step.id);

      const result = await getArtifactDownloadUrl(step.id, artifact.id, {
        userAuthz: fakeAuthz(),
        taskRunRepo: fakeStepRepo(step),
        artifactRepo: fakeArtifactRepo(artifact),
        objectStore: null,
        timeProvider: fixedTimeProvider(NOW),
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBeInstanceOf(ResourceNotFoundError);
    },
  );

  concurrentTest(
    "returns a UsageLimitExceededError (402) when the org is over its read cap",
    async () => {
      const step = runningStep();
      const artifact = anArtifact(step.id);
      const orgId = createUuidV7();
      const { store, presignKeys } = fakeObjectStore(PRESIGNED_URL);

      const result = await getArtifactDownloadUrl(step.id, artifact.id, {
        userAuthz: fakeAuthz(),
        taskRunRepo: fakeStepRepo(step),
        artifactRepo: fakeArtifactRepo(artifact),
        objectStore: store,
        timeProvider: fixedTimeProvider(NOW),
        orgRepo: fakeOrgRepo(orgId),
        usageMeterRepo: overCapUsageMeterRepo(orgId),
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBeInstanceOf(UsageLimitExceededError);
      expect((result.error as UsageLimitExceededError).kind).toBe("read");
      // blocked before minting a URL
      expect(presignKeys).toEqual([]);
    },
  );

  concurrentTest(
    "publishes the read-metering event on success when org + dispatcher are wired",
    async () => {
      const step = runningStep();
      const artifact = anArtifact(step.id);
      const orgId = createUuidV7();
      const { store } = fakeObjectStore(PRESIGNED_URL);
      const dispatcher = new InMemoryDomainEventDispatcher();
      const seen: LogArchiveRetrievedDomainEvent[] = [];
      const handler: DomainEventHandler<LogArchiveRetrievedDomainEvent> = {
        handle: (event) => {
          seen.push(event);
          return Promise.resolve();
        },
      };
      dispatcher.register(LOG_ARCHIVE_RETRIEVED_DOMAIN_EVENT_TYPE, handler);

      const result = await getArtifactDownloadUrl(step.id, artifact.id, {
        userAuthz: fakeAuthz(),
        taskRunRepo: fakeStepRepo(step),
        artifactRepo: fakeArtifactRepo(artifact),
        objectStore: store,
        timeProvider: fixedTimeProvider(NOW),
        orgRepo: fakeOrgRepo(orgId),
        usageMeterRepo: withHeadroomUsageMeterRepo(orgId),
        domainEventDispatcher: dispatcher,
        dbExecutor: fakeDbExecutor(),
      });

      expect(result.ok).toBe(true);
      expect(seen).toHaveLength(1);
      expect(seen[0]?.payload.orgId).toBe(orgId);
      expect(seen[0]?.payload.projectId).toBe(step.projectId);
      expect(seen[0]?.payload.taskRunId).toBe(step.id);
    },
  );

  concurrentTest(
    "skips the read-cap guard and usage event entirely for a public-project non-member grant (issue #149)",
    async () => {
      const step = runningStep();
      const artifact = anArtifact(step.id);
      const orgId = createUuidV7();
      const { store, presignKeys } = fakeObjectStore(PRESIGNED_URL);
      const orgRepo = fakeOrgRepo(orgId);
      const dispatcher = new InMemoryDomainEventDispatcher();
      const seen: LogArchiveRetrievedDomainEvent[] = [];
      const handler: DomainEventHandler<LogArchiveRetrievedDomainEvent> = {
        handle: (event) => {
          seen.push(event);
          return Promise.resolve();
        },
      };
      dispatcher.register(LOG_ARCHIVE_RETRIEVED_DOMAIN_EVENT_TYPE, handler);

      // Even though the org is over its read cap, a public-project
      // non-member read must still succeed and must never touch the org's
      // quota — neither the pre-flight guard nor the post-read usage event.
      const result = await getArtifactDownloadUrl(step.id, artifact.id, {
        userAuthz: fakeAuthz(/* isPublicNonMemberGrant */ true),
        taskRunRepo: fakeStepRepo(step),
        artifactRepo: fakeArtifactRepo(artifact),
        objectStore: store,
        timeProvider: fixedTimeProvider(NOW),
        orgRepo,
        usageMeterRepo: overCapUsageMeterRepo(orgId),
        domainEventDispatcher: dispatcher,
        dbExecutor: fakeDbExecutor(),
      });

      expect(result.ok).toBe(true);
      expect(presignKeys).toEqual([OBJECT_KEY]);
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(orgRepo.findByProjectId).not.toHaveBeenCalled();
      expect(seen).toHaveLength(0);
    },
  );
});
