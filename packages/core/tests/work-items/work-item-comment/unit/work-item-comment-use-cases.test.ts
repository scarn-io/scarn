import { describe, expect } from "bun:test";
import { createUuidV7 } from "@/common/contracts/uuid-v7";
import { ResourceNotFoundError } from "@/lib/errors";
import { concurrentTest, fixedTimeProvider } from "tests/utils";
import { createWorkItemCommentId } from "@/work-items/work-item-comment/domain/work-item-comment-id";
import { createWorkItemComment } from "@/work-items/work-item-comment/application/create-work-item-comment";
import { listWorkItemComments } from "@/work-items/work-item-comment/application/list-work-item-comments";
import { editWorkItemComment } from "@/work-items/work-item-comment/application/edit-work-item-comment";
import { setWorkItemCommentPin } from "@/work-items/work-item-comment/application/set-work-item-comment-pin";
import { deleteWorkItemComment } from "@/work-items/work-item-comment/application/delete-work-item-comment";
import {
  aComment,
  aWorkItemId,
  captureError,
  denyingAuthz,
  fakeCommentRepo,
  fakeCommentTaskNameReader,
  fakeUsernameReader,
  fakeWorkItemRepo,
  grantingAuthz,
  NOW,
} from "./work-item-comment-test-support";

const timeProvider = fixedTimeProvider(NOW);

describe("createWorkItemComment", () => {
  concurrentTest(
    "creates with author from actor, projectId from the work item, and checks comments:write",
    async () => {
      const projectId = createUuidV7();
      const workItemId = aWorkItemId();
      const actorId = createUuidV7();
      const userAuthz = grantingAuthz(actorId);
      const { repo, create } = fakeCommentRepo(null);

      const result = await createWorkItemComment(
        { workItemId, body: "please look at the auth bug" },
        {
          userAuthz,
          workItemRepo: fakeWorkItemRepo({ projectId }),
          workItemCommentRepo: repo,
          usernameReader: fakeUsernameReader(
            new Map([[actorId, "author_one"]]),
          ),
          timeProvider,
        },
      );

      expect(result.body).toBe("please look at the auth bug");
      expect(result.authorUserId).toBe(actorId);
      expect(result.authorUsername).toBe("author_one");
      expect(result.projectId).toBe(projectId);
      expect(result.isPinned).toBe(false);

      const created = create.mock.calls[0]?.[0];
      expect(created?.authorUserId).toBe(actorId);
      expect(created?.projectId).toBe(projectId);
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(userAuthz.requireProjectPermission).toHaveBeenCalledWith({
        projectId,
        permission: "comments:write",
        dbExecutor: undefined,
      });
    },
  );

  concurrentTest("throws when the work item does not exist", async () => {
    const error = await captureError(() =>
      createWorkItemComment(
        { workItemId: aWorkItemId(), body: "orphan" },
        {
          userAuthz: grantingAuthz(),
          workItemRepo: fakeWorkItemRepo(null),
          workItemCommentRepo: fakeCommentRepo(null).repo,
          usernameReader: fakeUsernameReader(),
          timeProvider,
        },
      ),
    );
    expect(error).toBeInstanceOf(ResourceNotFoundError);
  });

  concurrentTest(
    "propagates the authz denial when comments:write is not granted",
    async () => {
      const projectId = createUuidV7();
      const error = await captureError(() =>
        createWorkItemComment(
          { workItemId: aWorkItemId(), body: "no perms" },
          {
            userAuthz: denyingAuthz(createUuidV7(), "comments:write"),
            workItemRepo: fakeWorkItemRepo({ projectId }),
            workItemCommentRepo: fakeCommentRepo(null).repo,
            usernameReader: fakeUsernameReader(),
            timeProvider,
          },
        ),
      );
      expect(error).toMatchObject({ code: "PROJECT_FORBIDDEN", status: 403 });
    },
  );
});

describe("listWorkItemComments", () => {
  concurrentTest(
    "checks comments:read and returns mapped contracts",
    async () => {
      const projectId = createUuidV7();
      const workItemId = aWorkItemId();
      const authorUserId = createUuidV7();
      const userAuthz = grantingAuthz();
      const comment = aComment({ projectId, workItemId, authorUserId });
      const { repo, loadByWorkItemId } = fakeCommentRepo(comment);

      const result = await listWorkItemComments(workItemId, {
        userAuthz,
        workItemRepo: fakeWorkItemRepo({ projectId }),
        workItemCommentRepo: repo,
        usernameReader: fakeUsernameReader(
          new Map([[authorUserId, "review_bot"]]),
        ),
        commentTaskNameReader: fakeCommentTaskNameReader(),
      });

      expect(result).toHaveLength(1);
      const listedId = result[0]?.id ?? "";
      expect(listedId).toBe(String(comment.id));
      // Author username is resolved from the id at read time and attached to the
      // contract — the id remains the identity of record (decision D4).
      expect(result[0]?.authorUsername).toBe("review_bot");
      expect(loadByWorkItemId).toHaveBeenCalledTimes(1);
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(userAuthz.requireProjectPermission).toHaveBeenCalledWith({
        projectId,
        permission: "comments:read",
        dbExecutor: undefined,
      });
    },
  );

  concurrentTest("throws when the work item does not exist", async () => {
    const error = await captureError(() =>
      listWorkItemComments(aWorkItemId(), {
        userAuthz: grantingAuthz(),
        workItemRepo: fakeWorkItemRepo(null),
        workItemCommentRepo: fakeCommentRepo(null).repo,
        usernameReader: fakeUsernameReader(),
        commentTaskNameReader: fakeCommentTaskNameReader(),
      }),
    );
    expect(error).toBeInstanceOf(ResourceNotFoundError);
  });
});

describe("editWorkItemComment", () => {
  concurrentTest("author can edit their own comment", async () => {
    const projectId = createUuidV7();
    const authorUserId = createUuidV7();
    const comment = aComment({
      projectId,
      workItemId: aWorkItemId(),
      authorUserId,
      body: "old",
    });
    const { repo, save } = fakeCommentRepo(comment);

    const result = await editWorkItemComment(
      { commentId: comment.id, body: "new body" },
      {
        userAuthz: grantingAuthz(authorUserId),
        workItemCommentRepo: repo,
        usernameReader: fakeUsernameReader(
          new Map([[authorUserId, "editor_one"]]),
        ),
        timeProvider,
      },
    );

    expect(result.body).toBe("new body");
    expect(result.authorUsername).toBe("editor_one");
    expect(save).toHaveBeenCalledTimes(1);
  });

  concurrentTest(
    "rejects a non-author with PROJECT_FORBIDDEN even if they hold comments:write",
    async () => {
      const projectId = createUuidV7();
      const authorUserId = createUuidV7();
      const otherUserId = createUuidV7();
      const comment = aComment({
        projectId,
        workItemId: aWorkItemId(),
        authorUserId,
      });
      const { repo, save } = fakeCommentRepo(comment);

      const error = await captureError(() =>
        editWorkItemComment(
          { commentId: comment.id, body: "hijack" },
          {
            // grants everything, so the block must come from the author check
            userAuthz: grantingAuthz(otherUserId),
            workItemCommentRepo: repo,
            usernameReader: fakeUsernameReader(),
            timeProvider,
          },
        ),
      );
      expect(error).toMatchObject({ code: "PROJECT_FORBIDDEN", status: 403 });
      expect(save).not.toHaveBeenCalled();
    },
  );

  concurrentTest("throws when the comment does not exist", async () => {
    const error = await captureError(() =>
      editWorkItemComment(
        { commentId: createWorkItemCommentId(), body: "x" },
        {
          userAuthz: grantingAuthz(),
          workItemCommentRepo: fakeCommentRepo(null).repo,
          usernameReader: fakeUsernameReader(),
          timeProvider,
        },
      ),
    );
    expect(error).toBeInstanceOf(ResourceNotFoundError);
  });
});

describe("setWorkItemCommentPin", () => {
  concurrentTest(
    "pins team-wide (any comments:write holder, no author check) and persists isPinned",
    async () => {
      const projectId = createUuidV7();
      const authorUserId = createUuidV7();
      const nonAuthorId = createUuidV7();
      const comment = aComment({
        projectId,
        workItemId: aWorkItemId(),
        authorUserId,
        isPinned: false,
      });
      const { repo, save } = fakeCommentRepo(comment);
      const userAuthz = grantingAuthz(nonAuthorId);

      const result = await setWorkItemCommentPin(
        { commentId: comment.id, isPinned: true },
        {
          userAuthz,
          workItemCommentRepo: repo,
          usernameReader: fakeUsernameReader(),
          commentTaskNameReader: fakeCommentTaskNameReader(),
          timeProvider,
        },
      );

      expect(result.isPinned).toBe(true);
      const saved = save.mock.calls[0]?.[0];
      expect(saved?.isPinned).toBe(true);
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(userAuthz.requireProjectPermission).toHaveBeenCalledWith({
        projectId,
        permission: "comments:write",
        dbExecutor: undefined,
      });
    },
  );

  concurrentTest("unpins when isPinned is false", async () => {
    const projectId = createUuidV7();
    const comment = aComment({
      projectId,
      workItemId: aWorkItemId(),
      authorUserId: createUuidV7(),
      isPinned: true,
    });
    const { repo, save } = fakeCommentRepo(comment);

    const result = await setWorkItemCommentPin(
      { commentId: comment.id, isPinned: false },
      {
        userAuthz: grantingAuthz(),
        workItemCommentRepo: repo,
        usernameReader: fakeUsernameReader(),
        commentTaskNameReader: fakeCommentTaskNameReader(),
        timeProvider,
      },
    );

    expect(result.isPinned).toBe(false);
    expect(save.mock.calls[0]?.[0]?.isPinned).toBe(false);
  });

  concurrentTest(
    "propagates the authz denial when comments:write is not granted",
    async () => {
      const projectId = createUuidV7();
      const comment = aComment({
        projectId,
        workItemId: aWorkItemId(),
        authorUserId: createUuidV7(),
      });
      const error = await captureError(() =>
        setWorkItemCommentPin(
          { commentId: comment.id, isPinned: true },
          {
            userAuthz: denyingAuthz(createUuidV7(), "comments:write"),
            workItemCommentRepo: fakeCommentRepo(comment).repo,
            usernameReader: fakeUsernameReader(),
            commentTaskNameReader: fakeCommentTaskNameReader(),
            timeProvider,
          },
        ),
      );
      expect(error).toMatchObject({ code: "PROJECT_FORBIDDEN", status: 403 });
    },
  );
});

describe("deleteWorkItemComment", () => {
  concurrentTest(
    "author deletes their own comment WITHOUT needing comments:write",
    async () => {
      const projectId = createUuidV7();
      const authorUserId = createUuidV7();
      const comment = aComment({
        projectId,
        workItemId: aWorkItemId(),
        authorUserId,
      });
      const { repo, del } = fakeCommentRepo(comment);
      const userAuthz = grantingAuthz(authorUserId);

      const deleted = await deleteWorkItemComment(comment.id, {
        userAuthz,
        workItemCommentRepo: repo,
      });

      expect(deleted).toBe(1);
      expect(del).toHaveBeenCalledTimes(1);
      // author path must NOT consult project permissions
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(userAuthz.requireProjectPermission).not.toHaveBeenCalled();
    },
  );

  concurrentTest(
    "non-author may delete when they hold comments:write",
    async () => {
      const projectId = createUuidV7();
      const authorUserId = createUuidV7();
      const adminId = createUuidV7();
      const comment = aComment({
        projectId,
        workItemId: aWorkItemId(),
        authorUserId,
      });
      const { repo, del } = fakeCommentRepo(comment);
      const userAuthz = grantingAuthz(adminId);

      const deleted = await deleteWorkItemComment(comment.id, {
        userAuthz,
        workItemCommentRepo: repo,
      });

      expect(deleted).toBe(1);
      expect(del).toHaveBeenCalledTimes(1);
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(userAuthz.requireProjectPermission).toHaveBeenCalledWith({
        projectId,
        permission: "comments:write",
        dbExecutor: undefined,
      });
    },
  );

  concurrentTest(
    "non-author WITHOUT comments:write is rejected and nothing is deleted",
    async () => {
      const projectId = createUuidV7();
      const authorUserId = createUuidV7();
      const comment = aComment({
        projectId,
        workItemId: aWorkItemId(),
        authorUserId,
      });
      const { repo, del } = fakeCommentRepo(comment);

      const error = await captureError(() =>
        deleteWorkItemComment(comment.id, {
          userAuthz: denyingAuthz(createUuidV7(), "comments:write"),
          workItemCommentRepo: repo,
        }),
      );
      expect(error).toMatchObject({ code: "PROJECT_FORBIDDEN", status: 403 });
      expect(del).not.toHaveBeenCalled();
    },
  );

  concurrentTest("throws when the comment does not exist", async () => {
    const error = await captureError(() =>
      deleteWorkItemComment(createWorkItemCommentId(), {
        userAuthz: grantingAuthz(),
        workItemCommentRepo: fakeCommentRepo(null).repo,
      }),
    );
    expect(error).toBeInstanceOf(ResourceNotFoundError);
  });
});
