import { describe, expect, vi } from "bun:test";
import { concurrentTest, fixedTimeProvider } from "tests/utils";
import { createUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import type { UserAuthorizationService } from "@/access/authorization/application/user-authorization-service";
import type { TaskRunRepo } from "@/tasks/task-run/application/task-run-repo";
import type { TaskRepo } from "@/tasks/task/application/task-repo";
import { TaskEntity } from "@/tasks/task/domain/task-entity";
import { TaskRunEntity } from "@/tasks/task-run/domain/task-run-entity";
import { claimTaskRuns } from "@/tasks/task-run/application/claim-task-runs";
import type { DbExecutor } from "@/lib/db/db-executor";
import type { TerminalTaskRunHandlers } from "@/tasks/task-run/application/fail-terminal-task-runs";
import type { OrgRepo } from "@/organizations/organization/application/org-repo";
import type { OrganizationEntity } from "@/organizations/organization/domain/organization-entity";

const NOW = new Date("2026-07-01T12:00:00.000Z");

const fakeAuthz = (): UserAuthorizationService => ({
  actorId: createUuidV7(),
  requireProjectMember: () =>
    Promise.reject(new Error("requireProjectMember is not used here")),
  requireProjectPermission: vi.fn(() =>
    Promise.resolve({ membership: null, isPublicNonMemberGrant: false }),
  ),
});

/**
 * A row shaped as `claimBatch` would return it: already `running`, with a
 * claim token — `claimTaskRuns` now gets its claimed entities
 * straight from `claimBatch`'s return value rather than reloading them.
 */
const claimedCandidate = (
  projectId: UuidV7,
  claimToken = createUuidV7(),
): TaskRunEntity =>
  TaskRunEntity.rehydrate({
    id: createUuidV7(),
    taskId: createUuidV7(),
    number: 1,
    reason: "initial",
    projectId,
    workItemId: createUuidV7(),
    taskExecutionConfigId: createUuidV7(),
    kind: "agent",
    prompt: "Return a result payload.",
    status: "running",
    evaluatedAt: NOW,
    inputJson: {},
    claimedBy: "worker-a",
    claimToken,
    claimedAt: NOW,
    lastHeartbeatAt: NOW,
    leaseExpiresAt: new Date(NOW.getTime() + 30_000),
    startedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  });

const runningPastDeadline = (projectId: UuidV7): TaskRunEntity =>
  TaskRunEntity.rehydrate({
    ...claimedCandidate(projectId).toJSON(),
    id: createUuidV7(),
    executionDeadlineAt: new Date(NOW.getTime() - 1_000),
  });

const runningPastLease = (projectId: UuidV7): TaskRunEntity =>
  TaskRunEntity.rehydrate({
    ...claimedCandidate(projectId).toJSON(),
    id: createUuidV7(),
    leaseExpiresAt: new Date(NOW.getTime() - 1_000),
  });

/** Serves a queued agent Task for any run and saves whatever it is given. */
const fakeTaskRepo = (): TaskRepo =>
  ({
    lock: vi.fn((id: UuidV7) =>
      Promise.resolve(
        TaskEntity.create({
          id,
          projectId: createUuidV7(),
          workItemId: createUuidV7(),
          kind: "agent",
          prompt: "Return a result payload.",
          status: "queued",
          createdAt: NOW,
        }),
      ),
    ),
    save: vi.fn((task: TaskEntity) => Promise.resolve(task)),
  }) as unknown as TaskRepo;

const fakeOrgRepo = (orgId: UuidV7 | null) => {
  const findByProjectId = vi.fn(() =>
    Promise.resolve(
      orgId ? ({ id: orgId } as unknown as OrganizationEntity) : null,
    ),
  );
  const orgRepo: Pick<OrgRepo, "findByProjectId"> = { findByProjectId };
  return { orgRepo, findByProjectId };
};

const LOG_FEED = {
  url: "https://feed.example.com",
  tokenSecret: "log-feed-secret",
};

const claimInput = (projectId: UuidV7) => ({
  projectId,
  workerId: "worker-a",
  batchSize: 1,
  leaseDurationSeconds: 30,
});

/** Runs a transaction's callback straight away, on itself. */
const fakeDb = (): DbExecutor => {
  const db = {
    transaction: <T>(fn: (tx: DbExecutor) => Promise<T>) => fn(db),
  } as unknown as DbExecutor;
  return db;
};

const fakeHandlers = () => {
  const failTimedOut = vi.fn(() => Promise.reject(new Error("unused")));
  const failAbandoned = vi.fn(() => Promise.reject(new Error("unused")));
  const handlers: TerminalTaskRunHandlers = { failTimedOut, failAbandoned };
  return { handlers, failTimedOut, failAbandoned };
};

describe("claimTaskRuns", () => {
  concurrentTest(
    "passes the just-claimed entity straight through without reloading it",
    async () => {
      const projectId = createUuidV7();
      const claimed = claimedCandidate(projectId);
      const loadSpy = vi.fn(() => Promise.resolve(null));
      const taskRunRepo = {
        loadClaimableByProjectId: vi.fn(() => Promise.resolve([])),
        claimBatch: vi.fn(() => Promise.resolve([claimed])),
        listByTaskId: vi.fn(() => Promise.resolve([claimed])),
        load: loadSpy,
      } as unknown as TaskRunRepo;

      const claims = await claimTaskRuns(claimInput(projectId), {
        userAuthz: fakeAuthz(),
        taskRunRepo,
        taskRepo: fakeTaskRepo(),
        orgRepo: fakeOrgRepo(createUuidV7()).orgRepo,
        timeProvider: fixedTimeProvider(NOW),
        terminalTaskHandlers: fakeHandlers().handlers,
        logFeedConnection: null,
        dbExecutor: fakeDb(),
      });

      expect(claims).toHaveLength(1);
      expect(claims[0]?.task.id).toBe(claimed.id);
      expect(claims[0]?.claimToken).toBe(claimed.claimToken ?? "");
      expect(claims[0]?.logFeed).toBeNull();
      expect(loadSpy).not.toHaveBeenCalled();
    },
  );

  concurrentTest(
    "attaches a write token for the run's live log feed when it is configured",
    async () => {
      const projectId = createUuidV7();
      const orgId = createUuidV7();
      const claimed = claimedCandidate(projectId);
      const batch = [claimed, claimedCandidate(projectId)];
      const taskRunRepo = {
        loadClaimableByProjectId: vi.fn(() => Promise.resolve([])),
        claimBatch: vi.fn(() => Promise.resolve(batch)),
        listByTaskId: vi.fn(() => Promise.resolve(batch)),
      } as unknown as TaskRunRepo;
      const { orgRepo, findByProjectId } = fakeOrgRepo(orgId);

      const claims = await claimTaskRuns(
        { ...claimInput(projectId), batchSize: 2 },
        {
          userAuthz: fakeAuthz(),
          taskRunRepo,
          taskRepo: fakeTaskRepo(),
          orgRepo,
          timeProvider: fixedTimeProvider(NOW),
          terminalTaskHandlers: fakeHandlers().handlers,
          logFeedConnection: LOG_FEED,
          dbExecutor: fakeDb(),
        },
      );
      const [claim] = claims;

      const exp = NOW.getTime() / 1000 + 15 * 60;
      expect(claim?.logFeed).toMatchObject({
        url: `wss://feed.example.com/task-runs/${claimed.id}/ws`,
        expiresAt: new Date(exp * 1000).toISOString(),
      });
      const payload = claim?.logFeed?.token.split(".")[1] ?? "";
      expect(
        JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
      ).toEqual({
        tid: claimed.id,
        pid: projectId,
        oid: orgId,
        scope: "write",
        exp,
      });
      expect(claims[1]?.logFeed).not.toBeNull();
      expect(findByProjectId).toHaveBeenCalledTimes(1);
    },
  );

  concurrentTest(
    "claims without a log feed when the project has no org",
    async () => {
      const projectId = createUuidV7();
      const taskRunRepo = {
        loadClaimableByProjectId: vi.fn(() => Promise.resolve([])),
        claimBatch: vi.fn(() => Promise.resolve([claimedCandidate(projectId)])),
        listByTaskId: vi.fn(() => Promise.resolve([])),
      } as unknown as TaskRunRepo;

      const [claim] = await claimTaskRuns(claimInput(projectId), {
        userAuthz: fakeAuthz(),
        taskRunRepo,
        taskRepo: fakeTaskRepo(),
        orgRepo: fakeOrgRepo(null).orgRepo,
        timeProvider: fixedTimeProvider(NOW),
        terminalTaskHandlers: fakeHandlers().handlers,
        logFeedConnection: LOG_FEED,
        dbExecutor: fakeDb(),
      });

      expect(claim?.claimToken).toBeDefined();
      expect(claim?.logFeed).toBeNull();
    },
  );

  concurrentTest(
    "routes timed-out and abandoned candidates to the terminal handlers before claiming",
    async () => {
      const projectId = createUuidV7();
      const timedOut = runningPastDeadline(projectId);
      const abandoned = runningPastLease(projectId);
      const claimBatch = vi.fn(() => Promise.resolve([]));
      const taskRunRepo = {
        loadClaimableByProjectId: vi.fn(() =>
          Promise.resolve([timedOut, abandoned]),
        ),
        claimBatch,
      } as unknown as TaskRunRepo;
      const fakes = fakeHandlers();
      const db = fakeDb();

      await claimTaskRuns(claimInput(projectId), {
        userAuthz: fakeAuthz(),
        taskRunRepo,
        taskRepo: fakeTaskRepo(),
        orgRepo: fakeOrgRepo(createUuidV7()).orgRepo,
        timeProvider: fixedTimeProvider(NOW),
        terminalTaskHandlers: fakes.handlers,
        logFeedConnection: null,
        dbExecutor: db,
      });

      expect(fakes.failTimedOut).toHaveBeenCalledWith(timedOut.id, db);
      expect(fakes.failAbandoned).toHaveBeenCalledWith(abandoned.id, db);
      expect(claimBatch).toHaveBeenCalledTimes(1);
    },
  );
});
