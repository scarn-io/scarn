import { describe, expect, vi } from "bun:test";
import { createUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import { ResourceNotFoundError, UsageLimitExceededError } from "@/lib/errors";
import { concurrentTest, fixedTimeProvider } from "tests/utils";
import { InMemoryDomainEventDispatcher } from "@/lib/domain-events/in-memory-domain-event-dispatcher";
import type { DomainEventHandler } from "@/lib/domain-events/domain-event";
import {
  getTaskLogArchive,
  readTaskLogArchiveBytes,
} from "@/tasks/task-log/application/get-task-log-archive";
import { TaskRunEntity } from "@/tasks/task-run/domain/task-run-entity";
import type { TaskRunRepo } from "@/tasks/task-run/application/task-run-repo";
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
const PRESIGNED_URL = "https://store.example/archive?sig=abc";

type FakeExecutor = {
  transaction: <T>(cb: (tx: FakeExecutor) => Promise<T>) => Promise<T>;
};
const fakeDbExecutor = () => {
  const executor: FakeExecutor = {
    transaction: (cb) => cb(executor),
  };
  return executor as never;
};

const runningTask = (): TaskRunEntity =>
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

const fakeTaskRepo = (
  task: TaskRunEntity | null,
  archive: { storeRef: string; sizeBytes: number } | null,
): TaskRunRepo =>
  ({
    load: vi.fn(() => Promise.resolve(task)),
    getLogArchive: vi.fn(() => Promise.resolve(archive)),
  }) as unknown as TaskRunRepo;

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
      putObject: () => Promise.resolve({ sizeBytes: 0 }),
      deleteObject: () => Promise.resolve(),
      deletePrefix: () => Promise.resolve({ deletedCount: 0 }),
    },
  };
};

const fakeObjectStoreWithBytes = (
  body: Uint8Array,
): { store: ObjectStore; getObjectKeys: string[] } => {
  const getObjectKeys: string[] = [];
  return {
    getObjectKeys,
    store: {
      getPresignedGetUrl: () => Promise.resolve(null),
      getPresignedPutUrl: () => Promise.resolve(null),
      getObject: (key: string) => {
        getObjectKeys.push(key);
        return Promise.resolve({
          body,
          contentType: "application/x-ndjson",
          sizeBytes: body.byteLength,
        });
      },
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

describe("getTaskLogArchive", () => {
  concurrentTest(
    "happy path mints a presigned URL for the log archive",
    async () => {
      const step = runningTask();
      const archive = { storeRef: "s3://bucket/log.ndjson", sizeBytes: 1024 };
      const { store, presignKeys } = fakeObjectStore(PRESIGNED_URL);

      const result = await getTaskLogArchive(step.id, {
        userAuthz: fakeAuthz(),
        taskRunRepo: fakeTaskRepo(step, archive),
        objectStore: store,
        timeProvider: fixedTimeProvider(NOW),
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toEqual({ url: PRESIGNED_URL, sizeBytes: 1024 });
      expect(presignKeys).toEqual([archive.storeRef]);
    },
  );

  concurrentTest(
    "returns a ResourceNotFoundError when the task is missing",
    async () => {
      const { store } = fakeObjectStore(PRESIGNED_URL);

      const result = await getTaskLogArchive(createUuidV7(), {
        userAuthz: fakeAuthz(),
        taskRunRepo: fakeTaskRepo(null, null),
        objectStore: store,
        timeProvider: fixedTimeProvider(NOW),
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBeInstanceOf(ResourceNotFoundError);
    },
  );

  concurrentTest(
    "returns a UsageLimitExceededError (402) when a member is over the org's read cap",
    async () => {
      const step = runningTask();
      const archive = { storeRef: "s3://bucket/log.ndjson", sizeBytes: 1024 };
      const orgId = createUuidV7();
      const { store, presignKeys } = fakeObjectStore(PRESIGNED_URL);

      const result = await getTaskLogArchive(step.id, {
        userAuthz: fakeAuthz(),
        taskRunRepo: fakeTaskRepo(step, archive),
        objectStore: store,
        timeProvider: fixedTimeProvider(NOW),
        orgRepo: fakeOrgRepo(orgId),
        usageMeterRepo: overCapUsageMeterRepo(orgId),
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBeInstanceOf(UsageLimitExceededError);
      expect(presignKeys).toEqual([]);
    },
  );

  concurrentTest(
    "skips the read-cap guard and usage event entirely for a public-project non-member grant (issue #149)",
    async () => {
      const step = runningTask();
      const archive = { storeRef: "s3://bucket/log.ndjson", sizeBytes: 1024 };
      const orgId = createUuidV7();
      const { store, presignKeys } = fakeObjectStore(PRESIGNED_URL);
      const orgRepo = fakeOrgRepo(orgId);
      const dispatcher = new InMemoryDomainEventDispatcher();
      const seen: LogArchiveRetrievedDomainEvent[] = [];
      dispatcher.register(LOG_ARCHIVE_RETRIEVED_DOMAIN_EVENT_TYPE, {
        handle: (event) => {
          seen.push(event);
          return Promise.resolve();
        },
      } satisfies DomainEventHandler<LogArchiveRetrievedDomainEvent>);

      // Even though the org is over its read cap, a public-project
      // non-member read must still succeed and must never touch the org's
      // quota — neither the pre-flight guard nor the post-read usage event.
      const result = await getTaskLogArchive(step.id, {
        userAuthz: fakeAuthz(/* isPublicNonMemberGrant */ true),
        taskRunRepo: fakeTaskRepo(step, archive),
        objectStore: store,
        timeProvider: fixedTimeProvider(NOW),
        orgRepo,
        usageMeterRepo: overCapUsageMeterRepo(orgId),
        domainEventDispatcher: dispatcher,
        dbExecutor: fakeDbExecutor(),
      });

      expect(result.ok).toBe(true);
      expect(presignKeys).toEqual([archive.storeRef]);
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(orgRepo.findByProjectId).not.toHaveBeenCalled();
      expect(seen).toHaveLength(0);
    },
  );
});

describe("readTaskLogArchiveBytes", () => {
  concurrentTest("happy path proxies the raw archive bytes", async () => {
    const step = runningTask();
    const archive = { storeRef: "s3://bucket/log.ndjson", sizeBytes: 4 };
    const body = new Uint8Array([1, 2, 3, 4]);
    const { store, getObjectKeys } = fakeObjectStoreWithBytes(body);

    const result = await readTaskLogArchiveBytes(step.id, {
      userAuthz: fakeAuthz(),
      taskRunRepo: fakeTaskRepo(step, archive),
      objectStore: store,
      timeProvider: fixedTimeProvider(NOW),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual(body);
    expect(getObjectKeys).toEqual([archive.storeRef]);
  });

  concurrentTest(
    "returns a UsageLimitExceededError (402) when a member is over the org's read cap",
    async () => {
      const step = runningTask();
      const archive = { storeRef: "s3://bucket/log.ndjson", sizeBytes: 4 };
      const orgId = createUuidV7();
      const { store, getObjectKeys } = fakeObjectStoreWithBytes(
        new Uint8Array([1, 2, 3, 4]),
      );

      const result = await readTaskLogArchiveBytes(step.id, {
        userAuthz: fakeAuthz(),
        taskRunRepo: fakeTaskRepo(step, archive),
        objectStore: store,
        timeProvider: fixedTimeProvider(NOW),
        orgRepo: fakeOrgRepo(orgId),
        usageMeterRepo: overCapUsageMeterRepo(orgId),
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBeInstanceOf(UsageLimitExceededError);
      expect(getObjectKeys).toEqual([]);
    },
  );

  concurrentTest(
    "skips the read-cap guard and usage event entirely for a public-project non-member grant (issue #149)",
    async () => {
      const step = runningTask();
      const archive = { storeRef: "s3://bucket/log.ndjson", sizeBytes: 4 };
      const orgId = createUuidV7();
      const body = new Uint8Array([1, 2, 3, 4]);
      const { store, getObjectKeys } = fakeObjectStoreWithBytes(body);
      const orgRepo = fakeOrgRepo(orgId);
      const dispatcher = new InMemoryDomainEventDispatcher();
      const seen: LogArchiveRetrievedDomainEvent[] = [];
      dispatcher.register(LOG_ARCHIVE_RETRIEVED_DOMAIN_EVENT_TYPE, {
        handle: (event) => {
          seen.push(event);
          return Promise.resolve();
        },
      } satisfies DomainEventHandler<LogArchiveRetrievedDomainEvent>);

      // Even though the org is over its read cap, a public-project
      // non-member read must still succeed and must never touch the org's
      // quota — neither the pre-flight guard nor the post-read usage event.
      const result = await readTaskLogArchiveBytes(step.id, {
        userAuthz: fakeAuthz(/* isPublicNonMemberGrant */ true),
        taskRunRepo: fakeTaskRepo(step, archive),
        objectStore: store,
        timeProvider: fixedTimeProvider(NOW),
        orgRepo,
        usageMeterRepo: overCapUsageMeterRepo(orgId),
        domainEventDispatcher: dispatcher,
        dbExecutor: fakeDbExecutor(),
      });

      expect(result.ok).toBe(true);
      expect(getObjectKeys).toEqual([archive.storeRef]);
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(orgRepo.findByProjectId).not.toHaveBeenCalled();
      expect(seen).toHaveLength(0);
    },
  );
});
