import { describe, expect, vi } from "bun:test";
import { createUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import { ResourceNotFoundError } from "@/lib/errors";
import { concurrentTest } from "tests/utils";
import { listTaskArtifacts } from "@/tasks/task-artifact/application/list-task-artifacts";
import { TaskRunEntity } from "@/tasks/task-run/domain/task-run-entity";
import type { ArtifactRepo } from "@/tasks/task-artifact/application/artifact-repo";
import type { TaskRunRepo } from "@/tasks/task-run/application/task-run-repo";
import type { ArtifactContract } from "@/tasks/task-artifact/contracts/task-artifact-contracts";
import type {
  ProjectPermissionGrant,
  UserAuthorizationService,
} from "@/access/authorization/application/user-authorization-service";

const NOW = new Date("2026-05-01T12:00:00.000Z");

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
  }) as unknown as TaskRunRepo;

const anArtifact = (taskRunId: UuidV7): ArtifactContract => ({
  id: createUuidV7(),
  taskRunId,
  projectId: createUuidV7(),
  relativeStorePath: "reports/out.json",
  storeRef: "s3://bucket/key.json",
  objectKey: "artifacts/key.json",
  sizeBytes: 4096,
  contentType: "application/json",
  kind: "generic",
  createdAt: NOW.toISOString(),
});

const fakeArtifactRepo = (artifacts: ArtifactContract[]): ArtifactRepo => ({
  listByTask: vi.fn(() => Promise.resolve(artifacts)),
  findById: () => Promise.resolve(null),
  findWithRunContextById: () => Promise.resolve(null),
  listByProjectId: () => Promise.resolve([]),
  findManyByIds: () => Promise.resolve([]),
  softDeleteMany: () => Promise.resolve([]),
  record: () => Promise.reject(new Error("not used")),
  clearExpiredArtifacts: () => Promise.reject(new Error("not used")),
});

describe("listTaskArtifacts", () => {
  concurrentTest(
    "happy path returns the repo's artifacts and checks read permission",
    async () => {
      const step = runningStep();
      const artifacts = [anArtifact(step.id), anArtifact(step.id)];
      const userAuthz = fakeAuthz();

      const result = await listTaskArtifacts(step.id, {
        userAuthz,
        taskRunRepo: fakeStepRepo(step),
        artifactRepo: fakeArtifactRepo(artifacts),
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toEqual(artifacts);
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(userAuthz.requireProjectPermission).toHaveBeenCalledWith({
        projectId: step.projectId,
        permission: "executions:read",
      });
    },
  );

  concurrentTest("empty list returns an ok Result with []", async () => {
    const step = runningStep();

    const result = await listTaskArtifacts(step.id, {
      userAuthz: fakeAuthz(),
      taskRunRepo: fakeStepRepo(step),
      artifactRepo: fakeArtifactRepo([]),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([]);
  });

  concurrentTest(
    "returns a ResourceNotFoundError err Result when the step is missing",
    async () => {
      const step = runningStep();
      const userAuthz = fakeAuthz();
      const artifactRepo = fakeArtifactRepo([]);

      const result = await listTaskArtifacts(step.id, {
        userAuthz,
        taskRunRepo: fakeStepRepo(null),
        artifactRepo,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBeInstanceOf(ResourceNotFoundError);
      expect(result.error.name).toBe("ResourceNotFoundError");
      // authorization and the artifact listing are never reached
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(userAuthz.requireProjectPermission).not.toHaveBeenCalled();
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(artifactRepo.listByTask).not.toHaveBeenCalled();
    },
  );

  concurrentTest("propagates a throwing authorization check", async () => {
    const step = runningStep();
    const authzError = new Error("forbidden");
    const userAuthz: UserAuthorizationService = {
      actorId: createUuidV7(),
      requireProjectMember: () =>
        Promise.reject(new Error("requireProjectMember is not used here")),
      // eslint-disable-next-line @typescript-eslint/require-await
      requireProjectPermission: async (): Promise<ProjectPermissionGrant> => {
        throw authzError;
      },
    };

    let caught: unknown;
    try {
      await listTaskArtifacts(step.id, {
        userAuthz,
        taskRunRepo: fakeStepRepo(step),
        artifactRepo: fakeArtifactRepo([anArtifact(step.id)]),
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(authzError);
  });
});
