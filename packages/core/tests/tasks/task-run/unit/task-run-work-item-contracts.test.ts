import { describe, expect, test } from "bun:test";
import {
  agentWorkItemCommentSchema,
  agentWorkItemCommentsPageSchema,
  readTaskRunWorkItemInputSchema,
  taskRunWorkItemSchema,
  TASK_RUN_WORK_ITEM_COMMENTS_PAGE_SIZE,
} from "@/tasks/task-run/contracts/task-run-work-item-contracts";

const comment = agentWorkItemCommentSchema.parse({
  id: "01900000-0000-7000-8000-000000000001",
  parentCommentId: "01900000-0000-7000-8000-000000000002",
  body: "Research findings",
  authorKind: "agent",
  authorName: "Researcher",
  isPinned: true,
  createdAt: "2026-11-08T10:00:00.000Z",
  updatedAt: "2026-11-08T11:00:00.000Z",
});

describe("agent work-item comment contracts", () => {
  test("accepts an omitted cursor or preserves an opaque cursor unchanged", () => {
    const input = { claimToken: "claim", workItemId: comment.id };
    expect(readTaskRunWorkItemInputSchema.parse(input).commentsCursor).toBe(
      undefined,
    );
    const commentsCursor = "opaque+/= cursor";
    expect(
      readTaskRunWorkItemInputSchema.parse({ ...input, commentsCursor })
        .commentsCursor,
    ).toBe(commentsCursor);
    for (const invalid of [null, "", 1]) {
      expect(
        readTaskRunWorkItemInputSchema.safeParse({
          ...input,
          commentsCursor: invalid,
        }).success,
      ).toBe(false);
    }
  });

  test("exposes only agent-facing fields for human and agent authors", () => {
    for (const authorKind of ["user", "agent"] as const) {
      const parsed = agentWorkItemCommentSchema.parse({
        ...comment,
        authorKind,
        authorEmail: "private@example.com",
        authorUserId: comment.id,
        sourceNotificationId: comment.id,
      });
      expect(parsed).toEqual({ ...comment, authorKind });
    }
  });

  test("preserves complete bodies and parent IDs outside the page", () => {
    const body = `  ${"Detailed findings\n".repeat(10_000)}  `;
    const parsed = agentWorkItemCommentsPageSchema.parse({
      items: [{ ...comment, body }],
      totalCount: 2,
      nextCursor: "next-page",
    });
    expect(parsed.items[0]?.body).toBe(body);
    expect(parsed.items[0]?.parentCommentId).toBe(comment.parentCommentId);
  });

  test("accepts an empty final page and requires comments in work-item reads", () => {
    const page = { items: [], totalCount: 0, nextCursor: null };
    expect(agentWorkItemCommentsPageSchema.parse(page)).toEqual(page);
    expect(
      taskRunWorkItemSchema.shape.comments.safeParse(undefined).success,
    ).toBe(false);
    expect(taskRunWorkItemSchema.shape.comments.parse(page)).toEqual(page);
  });

  test("bounds pages at 50 even when every comment is pinned", () => {
    expect(TASK_RUN_WORK_ITEM_COMMENTS_PAGE_SIZE).toBe(50);
    const page = {
      items: Array.from({ length: 50 }, () => comment),
      totalCount: 51,
      nextCursor: "more-pinned-comments",
    };
    expect(agentWorkItemCommentsPageSchema.safeParse(page).success).toBe(true);
    expect(
      agentWorkItemCommentsPageSchema.safeParse({
        ...page,
        items: [...page.items, comment],
      }).success,
    ).toBe(false);
  });

  test("rejects invalid pagination metadata", () => {
    for (const totalCount of [-1, 0.5]) {
      expect(
        agentWorkItemCommentsPageSchema.safeParse({
          items: [],
          totalCount,
          nextCursor: null,
        }).success,
      ).toBe(false);
    }
    expect(
      agentWorkItemCommentsPageSchema.safeParse({
        items: [],
        totalCount: 1,
        nextCursor: "",
      }).success,
    ).toBe(false);
  });

  test("validates comment IDs, author kinds and timestamp conventions", () => {
    for (const invalid of [
      { id: "not-a-comment-id" },
      { parentCommentId: "not-a-parent-id" },
      { authorKind: "system" },
      { authorName: "" },
      { createdAt: "yesterday" },
      { updatedAt: "tomorrow" },
    ]) {
      expect(
        agentWorkItemCommentSchema.safeParse({ ...comment, ...invalid })
          .success,
      ).toBe(false);
    }
    expect(
      agentWorkItemCommentSchema.safeParse({
        ...comment,
        parentCommentId: null,
      }).success,
    ).toBe(true);
  });
});
