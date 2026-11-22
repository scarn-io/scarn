import { beforeAll, describe, expect } from "bun:test";
import { createApp } from "@scarn/api/app";
import { createAppContext } from "@/lib/di";
import { parseWorkItemId } from "@/work-items/work-item/domain/work-item-id";
import {
  createWorkItemCommentId,
  parseWorkItemCommentId,
} from "@/work-items/work-item-comment/domain/work-item-comment-id";
import { concurrentTest, fixedTimeProvider, unwrapAsync } from "tests/utils";
import { createScarnTreaty } from "tests/treaty";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import type { ProjectContract } from "@/projects/project/contracts/project-contracts";

type AuthHeaders = { authorization: string };

describe("work item comment post endpoint: replies", () => {
  const app = createApp(
    createAppContext({
      timeProvider: fixedTimeProvider(new Date("2026-04-22T12:00:00.000Z")),
    }),
  );
  const apiClient = createScarnTreaty(app);
  let project: ProjectContract | undefined;
  let authHeaders: AuthHeaders | undefined;

  const requireSetup = () => {
    if (!project || !authHeaders) throw new Error("setup incomplete");
    return { project, headers: authHeaders };
  };

  const createWorkItem = async () => {
    const { project, headers } = requireSetup();
    const workItem = await unwrapAsync(
      apiClient.api["work-items"].post(
        {
          projectId: project.id,
          platform: "github",
          platformId: `reply-wi-${crypto.randomUUID()}`,
          platformKey: `#reply-${crypto.randomUUID()}`,
          url: "https://github.com/example/repo/issues/1",
          title: "Export is broken",
          description: "It doesn't work",
          sourceCreatedAt: null,
          sourceUpdatedAt: null,
          fields: {},
        },
        { headers: { ...headers } },
      ),
    );
    return parseWorkItemId(workItem.id);
  };

  const postComment = (body: {
    workItemId: ReturnType<typeof parseWorkItemId>;
    body: string;
    parentCommentId?: ReturnType<typeof createWorkItemCommentId>;
  }) =>
    apiClient.api["work-item-comments"].post(body, {
      headers: { ...requireSetup().headers },
    });

  beforeAll(async () => {
    const owner = await createTestUserAndSession({
      email: `comment-replies-${crypto.randomUUID()}@example.com`,
    });
    authHeaders = owner.authHeaders;
    project = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: "Comment Replies Project",
          description: "Project for comment reply tests",
          gitUrl: "https://github.com/example/comment-replies.git",
        },
        { headers: { ...owner.authHeaders } },
      ),
    );
  });

  concurrentTest("a top-level comment has no parent", async () => {
    const workItemId = await createWorkItem();

    const comment = await unwrapAsync(
      postComment({ workItemId, body: "Which export?" }),
    );

    expect(comment.parentCommentId).toBeNull();
  });

  concurrentTest(
    "a reply to a top-level comment is listed with its parent",
    async () => {
      const workItemId = await createWorkItem();
      const parent = await unwrapAsync(
        postComment({ workItemId, body: "Which export, CSV or PDF?" }),
      );

      const reply = await unwrapAsync(
        postComment({
          workItemId,
          body: "CSV, Chrome, spinner forever.",
          parentCommentId: parseWorkItemCommentId(parent.id),
        }),
      );

      expect(reply.parentCommentId).toBe(parent.id);
      const listed = await unwrapAsync(
        apiClient.api["work-item-comments"].get({
          query: { workItemId },
          headers: { ...requireSetup().headers },
        }),
      );
      expect(
        listed.map((c) => ({ id: c.id, parentCommentId: c.parentCommentId })),
      ).toEqual([
        { id: parent.id, parentCommentId: null },
        { id: reply.id, parentCommentId: parent.id },
      ]);
    },
  );

  concurrentTest("a reply to a reply is rejected", async () => {
    const workItemId = await createWorkItem();
    const parent = await unwrapAsync(
      postComment({ workItemId, body: "Which browser?" }),
    );
    const reply = await unwrapAsync(
      postComment({
        workItemId,
        body: "Chrome",
        parentCommentId: parseWorkItemCommentId(parent.id),
      }),
    );

    const { data, error } = await postComment({
      workItemId,
      body: "Which version?",
      parentCommentId: parseWorkItemCommentId(reply.id),
    });

    expect(data).toBeNull();
    expect(error?.status).toBe(422);
    expect(error?.value).toMatchObject({
      code: "WORK_ITEM_COMMENT_PARENT_INVALID",
    });
  });

  concurrentTest(
    "a reply to a comment on another work item is rejected",
    async () => {
      const [workItemId, otherWorkItemId] = await Promise.all([
        createWorkItem(),
        createWorkItem(),
      ]);
      const otherComment = await unwrapAsync(
        postComment({ workItemId: otherWorkItemId, body: "Elsewhere" }),
      );

      const { data, error } = await postComment({
        workItemId,
        body: "Wrong thread",
        parentCommentId: parseWorkItemCommentId(otherComment.id),
      });

      expect(data).toBeNull();
      expect(error?.status).toBe(422);
      expect(error?.value).toMatchObject({
        code: "WORK_ITEM_COMMENT_PARENT_INVALID",
      });
    },
  );

  concurrentTest("a reply to a missing comment is rejected", async () => {
    const workItemId = await createWorkItem();

    const { data, error } = await postComment({
      workItemId,
      body: "Replying to nothing",
      parentCommentId: createWorkItemCommentId(),
    });

    expect(data).toBeNull();
    expect(error?.status).toBe(422);
    expect(error?.value).toMatchObject({
      code: "WORK_ITEM_COMMENT_PARENT_INVALID",
    });
  });
});
