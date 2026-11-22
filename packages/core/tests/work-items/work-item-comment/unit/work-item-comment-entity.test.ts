import { describe, expect, test } from "bun:test";
import { WorkItemCommentEntity } from "@/work-items/work-item-comment/domain/work-item-comment-entity";
import { CoreValidationError } from "@/lib/errors";
import { createUuidV7, parseUuidV7 } from "@/common/contracts/uuid-v7";
import { createWorkItemCommentId } from "@/work-items/work-item-comment/domain/work-item-comment-id";

const projectId = parseUuidV7("0196917c-532c-75aa-b7d5-0a84b71a1f02");
const workItemId = parseUuidV7("0196917c-532c-75aa-b7d5-0a84b71a1f03");
const authorUserId = parseUuidV7("0196917c-532c-75aa-b7d5-0a84b71a1f04");

const baseCreateProps = {
  projectId,
  workItemId,
  authorUserId,
  body: "This is a comment",
};

describe("work item comment entity", () => {
  test("throws when body is empty or whitespace-only", () => {
    expect(() =>
      WorkItemCommentEntity.create({ ...baseCreateProps, body: "   " }),
    ).toThrow(CoreValidationError);

    try {
      WorkItemCommentEntity.create({ ...baseCreateProps, body: "" });
    } catch (error) {
      expect(error).toBeInstanceOf(CoreValidationError);
      expect((error as CoreValidationError).code).toBe(
        "WORK_ITEM_COMMENT_BODY_REQUIRED",
      );
    }
  });

  test("create defaults isPinned to false and generates an id", () => {
    const comment = WorkItemCommentEntity.create(baseCreateProps);

    expect(comment.isPinned).toBe(false);
    expect(comment.id).toBeString();
    expect(comment.projectId).toBe(projectId);
    expect(comment.workItemId).toBe(workItemId);
    expect(comment.authorUserId).toBe(authorUserId);
    expect(comment.body).toBe("This is a comment");
  });

  test("create trims the body", () => {
    const comment = WorkItemCommentEntity.create({
      ...baseCreateProps,
      body: "  padded  ",
    });

    expect(comment.body).toBe("padded");
  });

  test("edit produces a new entity with updated body and updatedAt", () => {
    const original = WorkItemCommentEntity.create(baseCreateProps);
    const now = new Date("2026-04-22T12:00:00.000Z");
    const edited = original.edit("Updated body", now);

    expect(edited).not.toBe(original);
    expect(edited.id).toBe(original.id);
    expect(edited.body).toBe("Updated body");
    expect(edited.updatedAt).toEqual(now);
    expect(original.body).toBe("This is a comment");
  });

  test("pin and unpin produce expected new state", () => {
    const original = WorkItemCommentEntity.create(baseCreateProps);
    const now = new Date("2026-04-22T12:00:00.000Z");

    const pinned = original.pin(now);
    expect(pinned).not.toBe(original);
    expect(pinned.isPinned).toBe(true);
    expect(pinned.updatedAt).toEqual(now);
    expect(original.isPinned).toBe(false);

    const unpinned = pinned.unpin(now);
    expect(unpinned.isPinned).toBe(false);
  });

  test("setPinned reflects the provided value", () => {
    const original = WorkItemCommentEntity.create(baseCreateProps);

    expect(original.setPinned(true).isPinned).toBe(true);
    expect(original.setPinned(false).isPinned).toBe(false);
  });

  test("rehydrate preserves persisted fields", () => {
    const comment = WorkItemCommentEntity.rehydrate({
      id: "0196917c-532c-75aa-b7d5-0a84b71a1f05" as never,
      projectId,
      workItemId,
      authorUserId,
      body: "persisted",
      isPinned: true,
      createdAt: "2026-04-22T12:00:00.000Z",
      updatedAt: "2026-04-22T12:05:00.000Z",
    });

    expect(comment.isPinned).toBe(true);
    expect(comment.body).toBe("persisted");
    expect(comment.createdAt).toEqual(new Date("2026-04-22T12:00:00.000Z"));
    expect(comment.updatedAt).toEqual(new Date("2026-04-22T12:05:00.000Z"));
  });

  test("createAgentQuestion builds an agent comment with no session or source notification", () => {
    const now = new Date("2026-04-22T12:00:00.000Z");
    const question = WorkItemCommentEntity.createAgentQuestion({
      projectId,
      workItemId,
      body: "Before I can go on, could you answer:",
      createdAt: now,
    });

    expect(question.toJSON()).toMatchObject({
      authorKind: "agent",
      authorUserId: null,
      agentSessionId: null,
      sourceNotificationId: null,
      parentCommentId: null,
      isPinned: false,
      createdAt: now,
      updatedAt: now,
    });
  });

  test("createAgentComment records the authoring Task", () => {
    const taskId = createUuidV7();
    const comment = WorkItemCommentEntity.createAgentComment({
      projectId,
      workItemId,
      authoredByTaskId: taskId,
      body: "Shipped v2 behind a flag.",
      createdAt: new Date("2026-04-22T12:00:00.000Z"),
    });

    expect(comment.authoredByTaskId).toBe(taskId);
  });

  test("a user-authored comment can't have an authoring Task", () => {
    expect(() =>
      WorkItemCommentEntity.rehydrate({
        id: createWorkItemCommentId(),
        projectId,
        workItemId,
        authorUserId: createUuidV7(),
        authoredByTaskId: createUuidV7(),
        body: "mine",
      }),
    ).toThrow("User-authored comments must not have an authoring task");
  });
});
