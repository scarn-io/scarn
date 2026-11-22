import { describe, expect, vi } from "bun:test";
import { createUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import {
  ConfigurationError,
  ResourceOwnershipError,
  UsageLimitExceededError,
} from "@/lib/errors";
import { concurrentTest, fixedTimeProvider } from "tests/utils";
import { InMemoryObjectStore } from "@/artifacts/infra/in-memory-object-store";
import { createArtifactUploadUrl } from "@/tasks/task-artifact/application/create-artifact-upload-url";
import { deriveArtifactObjectKey } from "@/tasks/task-artifact/domain/artifact-object-key";
import { TaskRunEntity } from "@/tasks/task-run/domain/task-run-entity";
import type { TaskRunRepo } from "@/tasks/task-run/application/task-run-repo";
import type { ObjectStore } from "@/artifacts/object-store";
import type { OrgRepo } from "@/organizations/organization/application/org-repo";
import type { OrganizationEntity } from "@/organizations/organization/domain/organization-entity";
import type { UsageMeterRepo } from "@/billing/usage-meter/application/usage-meter-repo";
import { UsageMeter } from "@/billing/usage-meter/domain/usage-meter-entity";
import type { UserAuthorizationService } from "@/access/authorization/application/user-authorization-service";

const NOW = new Date("2026-05-01T12:00:00.000Z");
const CLAIM_TOKEN = "claim-token";

// The use case wraps its work in `db.transaction(cb)`. A fake executor whose
// `transaction` simply invokes the callback with itself keeps the test fully
// in-memory (the repo is a stub, so the executor is otherwise unused).
type FakeExecutor = {
  transaction: <T>(cb: (tx: FakeExecutor) => Promise<T>) => Promise<T>;
};
const fakeDbExecutor = () => {
  const executor: FakeExecutor = {
    transaction: (cb) => cb(executor),
  };
  return executor as never;
};

const runningStep = (claimToken: string | null): TaskRunEntity =>
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
    claimToken,
    claimedAt: NOW,
    leaseExpiresAt: new Date(NOW.getTime() + 60_000),
    startedAt: NOW,
  });

const fakeAuthz = (): UserAuthorizationService => ({
  actorId: createUuidV7(),
  requireProjectMember: () =>
    Promise.reject(new Error("requireProjectMember is not used here")),
  requireProjectPermission: vi.fn(() =>
    Promise.resolve({ membership: null, isPublicNonMemberGrant: false }),
  ),
});

const fakeRepo = (task: TaskRunEntity | null): TaskRunRepo =>
  ({
    load: vi.fn(() => Promise.resolve(task)),
    save: vi.fn((entity: TaskRunEntity) => Promise.resolve(entity)),
  }) as unknown as TaskRunRepo;

// A presign-capable store that records the args it was called with.
const presigningStore = (): {
  store: ObjectStore;
  calls: { key: string; expiresIn: number; contentType?: string }[];
} => {
  const calls: { key: string; expiresIn: number; contentType?: string }[] = [];
  return {
    calls,
    store: {
      putObject: () => Promise.resolve({ sizeBytes: 0 }),
      getObject: () => Promise.resolve(null),
      getPresignedGetUrl: () => Promise.resolve(null),
      getPresignedPutUrl: (
        key: string,
        expiresIn: number,
        contentType?: string,
      ) => {
        calls.push({ key, expiresIn, contentType });
        return Promise.resolve(`https://store.test/${key}`);
      },
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

/**
 * A usage-meter repo whose meter is at/over the "free" plan's write-count cap
 * (1000 writes/month — see `PLAN_LIMITS_CONFIG`).
 */
const overWriteCapUsageMeterRepo = (orgId: UuidV7): UsageMeterRepo =>
  ({
    loadOrStart: vi.fn(() =>
      Promise.resolve(
        UsageMeter.rehydrate({
          orgId,
          period: "2026-05",
          planId: "free",
          writes: 1000,
          reads: 0,
          storageBytes: 0,
          signalTokens: 0,
        }),
      ),
    ),
  }) as unknown as UsageMeterRepo;

/**
 * A usage-meter repo already at the "free" plan's storage-bytes cap
 * (256 MiB — `maxStorageBytes` = GIB / 4), with write headroom so only the
 * storage check can fail.
 */
const overStorageCapUsageMeterRepo = (orgId: UuidV7): UsageMeterRepo =>
  ({
    loadOrStart: vi.fn(() =>
      Promise.resolve(
        UsageMeter.rehydrate({
          orgId,
          period: "2026-05",
          planId: "free",
          writes: 0,
          reads: 0,
          storageBytes: (1024 * 1024 * 1024) / 4,
          signalTokens: 0,
        }),
      ),
    ),
  }) as unknown as UsageMeterRepo;

/** A usage-meter repo with plenty of write and storage headroom. */
const withHeadroomUsageMeterRepo = (orgId: UuidV7): UsageMeterRepo =>
  ({
    loadOrStart: vi.fn(() =>
      Promise.resolve(UsageMeter.startPeriod(orgId, "2026-05", "free")),
    ),
  }) as unknown as UsageMeterRepo;

const invoke = (
  step: TaskRunEntity,
  overrides: {
    objectStore?: ObjectStore | null;
    objectStorageBucket?: string | null;
    relativeStorePath?: string;
    contentType?: string;
    claimToken?: string;
    sizeBytes?: number;
    orgRepo?: OrgRepo;
    usageMeterRepo?: UsageMeterRepo;
  } = {},
) =>
  createArtifactUploadUrl(
    step.id,
    {
      claimToken: overrides.claimToken ?? CLAIM_TOKEN,
      relativeStorePath: overrides.relativeStorePath ?? "reports/out.json",
      contentType: overrides.contentType ?? "application/json",
      sizeBytes: overrides.sizeBytes,
    },
    {
      userAuthz: fakeAuthz(),
      taskRunRepo: fakeRepo(step),
      objectStore: overrides.objectStore,
      objectStorageBucket: overrides.objectStorageBucket,
      timeProvider: fixedTimeProvider(NOW),
      orgRepo: overrides.orgRepo,
      usageMeterRepo: overrides.usageMeterRepo,
      dbExecutor: fakeDbExecutor(),
    },
  );

describe("createArtifactUploadUrl", () => {
  concurrentTest(
    "happy path returns the minted URL, storeRef, key, and TTL",
    async () => {
      const step = runningStep(CLAIM_TOKEN);
      const { store, calls } = presigningStore();

      const result = await invoke(step, {
        objectStore: store,
        objectStorageBucket: "my-bucket",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const expectedKey = deriveArtifactObjectKey({
        projectId: step.projectId,
        taskRunId: step.id,
        relativeStorePath: "reports/out.json",
      });
      expect(result.value.objectKey).toBe(expectedKey);
      expect(result.value.uploadUrl).toBe(`https://store.test/${expectedKey}`);
      expect(result.value.storeRef).toBe(`s3://my-bucket/${expectedKey}`);
      expect(result.value.expiresInSeconds).toBe(900);
      // content-type is threaded through to the presigner.
      expect(calls[0]?.contentType).toBe("application/json");
      expect(calls[0]?.key).toBe(expectedKey);
    },
  );

  concurrentTest(
    "falls back to the bare object key when no bucket is configured",
    async () => {
      const step = runningStep(CLAIM_TOKEN);
      const { store } = presigningStore();

      const result = await invoke(step, { objectStore: store });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.storeRef).toBe(result.value.objectKey);
    },
  );

  concurrentTest(
    "returns a ResourceNotFoundError err Result when the step is missing",
    async () => {
      const step = runningStep(CLAIM_TOKEN);
      const { store } = presigningStore();
      const result = await createArtifactUploadUrl(
        step.id,
        { claimToken: CLAIM_TOKEN, relativeStorePath: "out.json" },
        {
          userAuthz: fakeAuthz(),
          taskRunRepo: fakeRepo(null),
          objectStore: store,
          timeProvider: fixedTimeProvider(NOW),
          dbExecutor: fakeDbExecutor(),
        },
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.name).toBe("ResourceNotFoundError");
    },
  );

  concurrentTest(
    "throws on claim ownership failure (wrong token)",
    async () => {
      const step = runningStep(CLAIM_TOKEN);
      const { store } = presigningStore();

      // assertClaimOwnership throws rather than returning an err Result.
      try {
        await invoke(step, { objectStore: store, claimToken: "wrong-token" });
        throw new Error("expected an ownership failure to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(ResourceOwnershipError);
      }
    },
  );

  concurrentTest(
    "returns the not-configured error when objectStore is null",
    async () => {
      const step = runningStep(CLAIM_TOKEN);

      const result = await invoke(step, { objectStore: null });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBeInstanceOf(ConfigurationError);
      expect(result.error.code).toBe("OBJECT_STORAGE_NOT_CONFIGURED");
    },
  );

  concurrentTest(
    "returns the presign-unsupported error when the store cannot presign",
    async () => {
      const step = runningStep(CLAIM_TOKEN);

      // InMemoryObjectStore.getPresignedPutUrl returns null.
      const result = await invoke(step, {
        objectStore: new InMemoryObjectStore(),
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBeInstanceOf(ConfigurationError);
      expect(result.error.code).toBe("OBJECT_STORAGE_PRESIGN_UNSUPPORTED");
    },
  );

  concurrentTest(
    "throws a validation error for an unsafe relativeStorePath",
    async () => {
      const step = runningStep(CLAIM_TOKEN);
      const { store } = presigningStore();

      let caught: unknown;
      try {
        await invoke(step, {
          objectStore: store,
          relativeStorePath: "../escape",
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
    },
  );

  concurrentTest(
    "returns a UsageLimitExceededError (402) when the org is over its write-count cap",
    async () => {
      const step = runningStep(CLAIM_TOKEN);
      const orgId = createUuidV7();
      const { store, calls } = presigningStore();

      const result = await invoke(step, {
        objectStore: store,
        orgRepo: fakeOrgRepo(orgId),
        usageMeterRepo: overWriteCapUsageMeterRepo(orgId),
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBeInstanceOf(UsageLimitExceededError);
      expect((result.error as UsageLimitExceededError).kind).toBe("write");
      // blocked before minting a URL
      expect(calls).toEqual([]);
    },
  );

  concurrentTest(
    "returns a UsageLimitExceededError (402) when a supplied sizeBytes would exceed the storage cap",
    async () => {
      const step = runningStep(CLAIM_TOKEN);
      const orgId = createUuidV7();
      const { store, calls } = presigningStore();

      const result = await invoke(step, {
        objectStore: store,
        orgRepo: fakeOrgRepo(orgId),
        usageMeterRepo: overStorageCapUsageMeterRepo(orgId),
        sizeBytes: 1024,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBeInstanceOf(UsageLimitExceededError);
      expect((result.error as UsageLimitExceededError).kind).toBe("storage");
      expect(calls).toEqual([]);
    },
  );

  concurrentTest(
    "does not check storage when sizeBytes is omitted, even if storage is over cap",
    async () => {
      const step = runningStep(CLAIM_TOKEN);
      const orgId = createUuidV7();
      const { store } = presigningStore();

      // sizeBytes omitted: only the write-count cap is checked, so an org over
      // its storage cap (but with write headroom) still succeeds — this is the
      // documented "already over cap" hard-stop fallback for when the caller
      // (an older worker) doesn't know the size yet.
      const result = await invoke(step, {
        objectStore: store,
        orgRepo: fakeOrgRepo(orgId),
        usageMeterRepo: overStorageCapUsageMeterRepo(orgId),
      });

      expect(result.ok).toBe(true);
    },
  );

  concurrentTest(
    "succeeds with the existing response shape for an org under cap",
    async () => {
      const step = runningStep(CLAIM_TOKEN);
      const orgId = createUuidV7();
      const { store } = presigningStore();

      const result = await invoke(step, {
        objectStore: store,
        objectStorageBucket: "my-bucket",
        orgRepo: fakeOrgRepo(orgId),
        usageMeterRepo: withHeadroomUsageMeterRepo(orgId),
        sizeBytes: 2048,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const expectedKey = deriveArtifactObjectKey({
        projectId: step.projectId,
        taskRunId: step.id,
        relativeStorePath: "reports/out.json",
      });
      expect(result.value).toEqual({
        uploadUrl: `https://store.test/${expectedKey}`,
        storeRef: `s3://my-bucket/${expectedKey}`,
        objectKey: expectedKey,
        expiresInSeconds: 900,
      });
    },
  );

  concurrentTest(
    "skips the usage guard entirely when orgRepo/usageMeterRepo are not wired",
    async () => {
      const step = runningStep(CLAIM_TOKEN);
      const { store } = presigningStore();

      // No orgRepo/usageMeterRepo supplied — matches every other test above
      // this section, which never wires them. Asserting it explicitly here
      // documents the optional-dep contract.
      const result = await invoke(step, { objectStore: store });

      expect(result.ok).toBe(true);
    },
  );
});
