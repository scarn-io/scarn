import { describe, expect, vi } from "bun:test";
import { createUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import { CoreValidationError, ResourceOwnershipError } from "@/lib/errors";
import { concurrentTest, fixedTimeProvider } from "tests/utils";
import { InMemoryDomainEventDispatcher } from "@/lib/domain-events/in-memory-domain-event-dispatcher";
import type { DomainEventHandler } from "@/lib/domain-events/domain-event";
import { recordTaskArtifact } from "@/tasks/task-artifact/application/record-task-artifact";
import {
  ARTIFACT_STORED_DOMAIN_EVENT_TYPE,
  type ArtifactStoredDomainEvent,
} from "@/tasks/task-artifact/domain/artifact-stored.domain-event";
import { deriveArtifactObjectKey } from "@/tasks/task-artifact/domain/artifact-object-key";
import { TaskRunEntity } from "@/tasks/task-run/domain/task-run-entity";
import type {
  ArtifactRepo,
  RecordArtifactRow,
} from "@/tasks/task-artifact/application/artifact-repo";
import type { TaskRunRepo } from "@/tasks/task-run/application/task-run-repo";
import type { ArtifactContract } from "@/tasks/task-artifact/contracts/task-artifact-contracts";
import type { OrgRepo } from "@/organizations/organization/application/org-repo";
import type { OrganizationEntity } from "@/organizations/organization/domain/organization-entity";
import type { UserAuthorizationService } from "@/access/authorization/application/user-authorization-service";
import { noopAnalytics } from "@/lib/analytics/analytics-port";
import { RecordingAnalytics } from "@/lib/analytics/recording-analytics";
import { AnalyticsEvents } from "@scarn/observability/analytics/events";

const NOW = new Date("2026-05-01T12:00:00.000Z");
const CLAIM_TOKEN = "claim-token";
const RELATIVE_PATH = "reports/out.json";

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

const fakeStepRepo = (task: TaskRunEntity | null): TaskRunRepo =>
  ({
    load: vi.fn(() => Promise.resolve(task)),
    save: vi.fn((entity: TaskRunEntity) => Promise.resolve(entity)),
  }) as unknown as TaskRunRepo;

const fakeArtifactRepo = (): {
  repo: ArtifactRepo;
  rows: RecordArtifactRow[];
} => {
  const rows: RecordArtifactRow[] = [];
  return {
    rows,
    repo: {
      record: (input: RecordArtifactRow): Promise<ArtifactContract> => {
        rows.push(input);
        return Promise.resolve({
          id: input.id,
          taskRunId: input.taskRunId,
          projectId: input.projectId,
          relativeStorePath: input.relativeStorePath,
          storeRef: input.storeRef,
          objectKey: input.objectKey,
          sizeBytes: input.sizeBytes,
          contentType: input.contentType,
          kind: input.kind,
          createdAt: NOW.toISOString(),
        });
      },
      listByTask: () => Promise.resolve([]),
      findById: () => Promise.resolve(null),
      findWithRunContextById: () => Promise.resolve(null),
      listByProjectId: () => Promise.resolve([]),
      findManyByIds: () => Promise.resolve([]),
      softDeleteMany: () => Promise.resolve([]),
      clearExpiredArtifacts: () => Promise.reject(new Error("not used")),
    },
  };
};

const fakeOrgRepo = (orgId: UuidV7): OrgRepo =>
  ({
    findByProjectId: vi.fn(() =>
      Promise.resolve({ id: orgId } as unknown as OrganizationEntity),
    ),
  }) as unknown as OrgRepo;

const invoke = (
  step: TaskRunEntity,
  deps: {
    artifactRepo: ArtifactRepo;
    objectStorageBucket?: string | null;
    orgRepo?: OrgRepo;
    domainEventDispatcher?: InMemoryDomainEventDispatcher;
    analytics?: RecordingAnalytics;
    userAuthz?: UserAuthorizationService;
  },
  input: {
    claimToken?: string;
    objectKey?: string;
    relativeStorePath?: string;
    sizeBytes?: number;
    kind?: "generic" | "playwright-trace";
  } = {},
) => {
  const relativeStorePath = input.relativeStorePath ?? RELATIVE_PATH;
  const derivedKey = deriveArtifactObjectKey({
    projectId: step.projectId,
    taskRunId: step.id,
    relativeStorePath,
  });
  return recordTaskArtifact(
    step.id,
    {
      claimToken: input.claimToken ?? CLAIM_TOKEN,
      objectKey: input.objectKey ?? derivedKey,
      relativeStorePath,
      sizeBytes: input.sizeBytes ?? 4096,
      contentType: "application/json",
      ...(input.kind ? { kind: input.kind } : {}),
    },
    {
      userAuthz: deps.userAuthz ?? fakeAuthz(),
      taskRunRepo: fakeStepRepo(step),
      artifactRepo: deps.artifactRepo,
      objectStorageBucket: deps.objectStorageBucket,
      orgRepo: deps.orgRepo,
      timeProvider: fixedTimeProvider(NOW),
      domainEventDispatcher: deps.domainEventDispatcher,
      analytics: deps.analytics ?? noopAnalytics,
      dbExecutor: fakeDbExecutor(),
    },
  );
};

describe("recordTaskArtifact", () => {
  concurrentTest(
    "happy path persists the artifact and returns it",
    async () => {
      const step = runningStep(CLAIM_TOKEN);
      const { repo, rows } = fakeArtifactRepo();

      const result = await invoke(step, {
        artifactRepo: repo,
        objectStorageBucket: "my-bucket",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const expectedKey = deriveArtifactObjectKey({
        projectId: step.projectId,
        taskRunId: step.id,
        relativeStorePath: RELATIVE_PATH,
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.objectKey).toBe(expectedKey);
      expect(rows[0]?.storeRef).toBe(`s3://my-bucket/${expectedKey}`);
      expect(rows[0]?.sizeBytes).toBe(4096);
      expect(result.value.objectKey).toBe(expectedKey);
      expect(result.value.sizeBytes).toBe(4096);
    },
  );

  concurrentTest("defaults kind to generic when omitted", async () => {
    const step = runningStep(CLAIM_TOKEN);
    const { repo, rows } = fakeArtifactRepo();

    const result = await invoke(step, { artifactRepo: repo });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(rows[0]?.kind).toBe("generic");
    expect(result.value.kind).toBe("generic");
  });

  concurrentTest(
    "persists and returns kind: playwright-trace when supplied",
    async () => {
      const step = runningStep(CLAIM_TOKEN);
      const { repo, rows } = fakeArtifactRepo();

      const result = await invoke(
        step,
        { artifactRepo: repo },
        { kind: "playwright-trace" },
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(rows[0]?.kind).toBe("playwright-trace");
      expect(result.value.kind).toBe("playwright-trace");
    },
  );

  concurrentTest(
    "anti-spoof: a mismatched objectKey returns an err Result and persists nothing",
    async () => {
      const step = runningStep(CLAIM_TOKEN);
      const { repo, rows } = fakeArtifactRepo();

      const result = await invoke(
        step,
        { artifactRepo: repo },
        {
          objectKey: "artifacts/spoofed/key.json",
        },
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBeInstanceOf(CoreValidationError);
      expect(result.error.code).toBe("ARTIFACT_OBJECT_KEY_MISMATCH");
      expect(rows).toHaveLength(0);
    },
  );

  concurrentTest(
    "throws on claim ownership failure (wrong token)",
    async () => {
      const step = runningStep(CLAIM_TOKEN);
      const { repo, rows } = fakeArtifactRepo();

      let caught: unknown;
      try {
        await invoke(
          step,
          { artifactRepo: repo },
          { claimToken: "wrong-token" },
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ResourceOwnershipError);
      expect(rows).toHaveLength(0);
    },
  );

  concurrentTest(
    "returns a ResourceNotFoundError err Result when the step is missing",
    async () => {
      const step = runningStep(CLAIM_TOKEN);
      const { repo } = fakeArtifactRepo();

      const result = await recordTaskArtifact(
        step.id,
        {
          claimToken: CLAIM_TOKEN,
          objectKey: "artifacts/x/y/out.json",
          relativeStorePath: RELATIVE_PATH,
          sizeBytes: 1,
        },
        {
          userAuthz: fakeAuthz(),
          taskRunRepo: fakeStepRepo(null),
          artifactRepo: repo,
          timeProvider: fixedTimeProvider(NOW),
          analytics: noopAnalytics,
          dbExecutor: fakeDbExecutor(),
        },
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.name).toBe("ResourceNotFoundError");
    },
  );

  concurrentTest(
    "dispatches an ARTIFACT_STORED domain event when org + dispatcher are wired",
    async () => {
      const step = runningStep(CLAIM_TOKEN);
      const { repo } = fakeArtifactRepo();
      const orgId = createUuidV7();
      const dispatcher = new InMemoryDomainEventDispatcher();
      const seen: ArtifactStoredDomainEvent[] = [];
      const handler: DomainEventHandler<ArtifactStoredDomainEvent> = {
        handle: (event) => {
          seen.push(event);
          return Promise.resolve();
        },
      };
      dispatcher.register(ARTIFACT_STORED_DOMAIN_EVENT_TYPE, handler);

      const result = await invoke(step, {
        artifactRepo: repo,
        orgRepo: fakeOrgRepo(orgId),
        domainEventDispatcher: dispatcher,
      });

      expect(result.ok).toBe(true);
      expect(seen).toHaveLength(1);
      expect(seen[0]?.payload.orgId).toBe(orgId);
      expect(seen[0]?.payload.projectId).toBe(step.projectId);
      expect(seen[0]?.payload.taskRunId).toBe(step.id);
      expect(seen[0]?.payload.sizeBytes).toBe(4096);
    },
  );

  concurrentTest(
    "captures artifact_produced for the actor once the artifact is recorded",
    async () => {
      const step = runningStep(CLAIM_TOKEN);
      const { repo } = fakeArtifactRepo();
      const analytics = new RecordingAnalytics();
      const userAuthz = fakeAuthz();

      const result = await invoke(
        step,
        { artifactRepo: repo, analytics, userAuthz },
        { kind: "playwright-trace" },
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(analytics.calls).toEqual([
        {
          distinctId: userAuthz.actorId,
          event: AnalyticsEvents.ArtifactProduced,
          properties: {
            project_id: step.projectId,
            task_id: step.id,
            artifact_id: result.value.id,
            kind: "playwright-trace",
          },
        },
      ]);
    },
  );

  concurrentTest(
    "does not capture artifact_produced when the artifact is rejected",
    async () => {
      const step = runningStep(CLAIM_TOKEN);
      const { repo } = fakeArtifactRepo();
      const analytics = new RecordingAnalytics();

      const result = await invoke(
        step,
        { artifactRepo: repo, analytics },
        { objectKey: "artifacts/spoofed/key.json" },
      );

      expect(result.ok).toBe(false);
      expect(analytics.calls).toHaveLength(0);
    },
  );
});
