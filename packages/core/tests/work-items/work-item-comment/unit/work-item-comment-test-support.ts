import { vi } from "bun:test";
import { createUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import { CoreError } from "@/lib/errors";
import type {
  ProjectPermissionGrant,
  RequireProjectPermissionInput,
  UserAuthorizationService,
} from "@/access/authorization/application/user-authorization-service";

import type { WorkItemRepo } from "@/work-items/work-item/application/work-item-repo";
import type { WorkItemCommentRepo } from "@/work-items/work-item-comment/application/work-item-comment-repo";
import type { UsernameReader } from "@/organizations/organization/application/username-reader";
import type { CommentTaskNameReader } from "@/work-items/work-item-comment/application/comment-task-name-reader";
import { WorkItemCommentEntity } from "@/work-items/work-item-comment/domain/work-item-comment-entity";
import { createWorkItemCommentId } from "@/work-items/work-item-comment/domain/work-item-comment-id";

export const NOW = new Date("2026-05-01T12:00:00.000Z");

const grantedPermission: ProjectPermissionGrant = {
  membership: null,
  isPublicNonMemberGrant: false,
};

// The repo/codebase idiom asserts rejections via try/catch (the bun
// expect().rejects matcher trips the await-thenable lint rule under the TS
// ESLint config). This captures the thrown error for inspection.
export const captureError = async (
  fn: () => Promise<unknown>,
): Promise<unknown> => {
  try {
    await fn();
  } catch (caught: unknown) {
    return caught;
  }
  throw new Error("Expected the operation to throw, but it resolved");
};

// A work item id must be a UUID v7 string; the use-cases parse it via
// parseWorkItemId, so any valid v7 works.
export const aWorkItemId = (): UuidV7 => createUuidV7();

// Authz fake whose requireProjectPermission resolves (permission granted).
export const grantingAuthz = (
  actorId: UuidV7 = createUuidV7(),
): UserAuthorizationService => ({
  actorId,
  requireProjectMember: () =>
    Promise.reject(new Error("requireProjectMember is not used here")),
  requireProjectPermission: vi.fn(() => Promise.resolve(grantedPermission)),
});

// Authz fake that DENIES a specific permission (throws the 403 the real
// service throws), while allowing everything else.
export const denyingAuthz = (
  actorId: UuidV7,
  deniedPermission: string,
): UserAuthorizationService => ({
  actorId,
  requireProjectMember: () =>
    Promise.reject(new Error("requireProjectMember is not used here")),
  requireProjectPermission: vi.fn(
    (input: RequireProjectPermissionInput): Promise<ProjectPermissionGrant> =>
      input.permission === deniedPermission
        ? Promise.reject(
            new CoreError({
              code: "PROJECT_FORBIDDEN",
              message: "denied",
              status: 403,
            }),
          )
        : Promise.resolve(grantedPermission),
  ),
});

export const fakeWorkItemRepo = (
  workItem: { projectId: UuidV7 } | null,
): WorkItemRepo =>
  ({ load: vi.fn(() => Promise.resolve(workItem)) }) as unknown as WorkItemRepo;

// Username reader fake: resolves the given ids against a fixed map so the
// read-time author label can be asserted (unknown ids are simply omitted).
export const fakeUsernameReader = (
  usernames: Map<UuidV7, string> = new Map(),
): UsernameReader => ({
  loadUsernamesByUserId: vi.fn((ids: readonly UuidV7[]) =>
    Promise.resolve(
      new Map(
        ids
          .filter((id) => usernames.has(id))
          .map((id) => [
            id,
            { username: usernames.get(id) ?? "", image: null },
          ]),
      ),
    ),
  ),
});

// Task name reader fake: resolves the given Task ids against a fixed map.
export const fakeCommentTaskNameReader = (
  names: Map<UuidV7, string> = new Map(),
): CommentTaskNameReader => ({
  loadTaskNamesByTaskId: vi.fn((ids: readonly UuidV7[]) =>
    Promise.resolve(
      new Map(
        ids
          .filter((id) => names.has(id))
          .map((id) => [id, names.get(id) ?? ""]),
      ),
    ),
  ),
});

export const anAgentTaskComment = (props: {
  projectId: UuidV7;
  workItemId: UuidV7;
  authoredByTaskId: UuidV7;
}): WorkItemCommentEntity =>
  WorkItemCommentEntity.createAgentComment({
    ...props,
    body: "Shipped v2 behind a flag.",
    createdAt: NOW,
  });

export const aComment = (props: {
  projectId: UuidV7;
  workItemId: UuidV7;
  authorUserId: UuidV7;
  body?: string;
  isPinned?: boolean;
}): WorkItemCommentEntity =>
  WorkItemCommentEntity.rehydrate({
    id: createWorkItemCommentId(),
    projectId: props.projectId,
    workItemId: props.workItemId,
    authorUserId: props.authorUserId,
    body: props.body ?? "a comment",
    isPinned: props.isPinned ?? false,
    createdAt: NOW,
    updatedAt: NOW,
  });

// Comment repo fake that echoes what it is asked to persist and serves a single
// loaded comment. `create`/`save` return their argument so contract mapping runs
// against real entity data.
export const fakeCommentRepo = (loaded: WorkItemCommentEntity | null) => {
  const create = vi.fn((c: WorkItemCommentEntity) => Promise.resolve(c));
  const save = vi.fn((c: WorkItemCommentEntity) => Promise.resolve(c));
  const del = vi.fn(() => Promise.resolve(1));
  const loadByWorkItemId = vi.fn(() => Promise.resolve(loaded ? [loaded] : []));
  const repo = {
    create,
    save,
    delete: del,
    load: vi.fn(() => Promise.resolve(loaded)),
    loadByWorkItemId,
    loadPinnedByWorkItemId: vi.fn(() => Promise.resolve([])),
  } as unknown as WorkItemCommentRepo;
  return { repo, create, save, del, loadByWorkItemId };
};
