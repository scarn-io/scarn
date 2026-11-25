import { beforeAll, describe, expect } from "bun:test";
import { createApp } from "@scarn/api/app";
import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { parseWorkItemId } from "@/work-items/work-item/domain/work-item-id";
import { createAppContext } from "@/lib/di";
import { fixedTimeProvider, serialTest, unwrapAsync } from "tests/utils";
import { createScarnTreaty } from "tests/treaty";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import {
  createPipelineFromDocument,
  latestTaskIdForNode,
  singleStepPipelineDocument,
} from "tests/pipeline-definitions/pipeline-test-support";
import type { ProjectContract } from "@/projects/project/contracts/project-contracts";
import type { WorkItemContract } from "@/work-items/work-item/contracts/work-item-contracts";
import type { WorkItemCommentContract } from "@/work-items/work-item-comment/contracts/work-item-comment-contracts";

type Client = ReturnType<typeof createScarnTreaty>;
type AuthHeaders = { authorization: string };

// Drives a pipeline execution for the work item and returns the first queued
// task's inputJson, so we can assert what pinned comments the agent
// would see.
const runFirstStepAndLoadInput = async (
  apiClient: Client,
  authHeaders: AuthHeaders,
  projectId: UuidV7,
  workItemId: UuidV7,
): Promise<unknown> => {
  const stepDefinition = await unwrapAsync(
    apiClient.api["step-definitions"].post(
      {
        projectId,
        key: `comment_binding_${crypto.randomUUID()}`,
        name: "Comment binding step",
        description: "Comment binding step",
        prompt: "Do the work",
        version: 1,
        kind: "user_defined" as const,
        inputSchemaJson: { type: "object" },
        resultSchemaJson: { type: "object" },
        status: "active" as const,
      },
      { headers: { ...authHeaders } },
    ),
  );

  const document = singleStepPipelineDocument(
    `pipeline_comment_${crypto.randomUUID()}`,
    stepDefinition.key,
  );
  const definition = await createPipelineFromDocument(
    apiClient,
    authHeaders,
    projectId,
    {
      ...document,
      start: { ...document.start, args: { subject: "workItem.title" } },
    },
    "Comment context pipeline",
  );

  const execution = await unwrapAsync(
    apiClient.api["pipeline-executions"].post(
      {
        projectId,
        workItemId,
        pipelineDefinitionId: definition.id,
      },
      { headers: { ...authHeaders } },
    ),
  );

  return (
    await unwrapAsync(
      apiClient.api["task-runs"]({
        taskRunId: latestTaskIdForNode(execution),
      }).get({ headers: { ...authHeaders } }),
    )
  ).inputJson;
};

describe("work item comment lifecycle", () => {
  let project: ProjectContract | undefined;
  let authHeaders: AuthHeaders | undefined;
  let workItem: WorkItemContract | undefined;
  let comment: WorkItemCommentContract | undefined;
  let ownerUsername: string | undefined;

  const app = createApp(
    createAppContext({
      timeProvider: fixedTimeProvider(new Date("2026-04-22T12:00:00.000Z")),
    }),
  );
  const apiClient = createScarnTreaty(app);

  beforeAll(async () => {
    ownerUsername = `author${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
    const owner = await createTestUserAndSession({
      email: `comment-lifecycle-${crypto.randomUUID()}@example.com`,
      username: ownerUsername,
    });
    authHeaders = owner.authHeaders;
    project = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: "Comment Lifecycle Project",
          description: "Project for comment lifecycle tests",
          gitUrl: "https://github.com/example/comment-project.git",
        },
        { headers: { ...owner.authHeaders } },
      ),
    );
    workItem = await unwrapAsync(
      apiClient.api["work-items"].post(
        {
          projectId: project.id,
          platform: "github",
          platformId: `comment-wi-${crypto.randomUUID()}`,
          platformKey: `#comment-${crypto.randomUUID()}`,
          url: "https://github.com/example/repo/issues/1",
          title: "Commentable work item",
          description: "A work item to comment on",
          sourceCreatedAt: null,
          sourceUpdatedAt: null,
          fields: {},
        },
        { headers: { ...owner.authHeaders } },
      ),
    );
  });

  serialTest("creates a comment (unpinned by default)", async () => {
    if (!workItem || !authHeaders) throw new Error("setup incomplete");

    comment = await unwrapAsync(
      apiClient.api["work-item-comments"].post(
        {
          workItemId: parseWorkItemId(workItem.id),
          body: "please prioritize the login flow",
        },
        { headers: { ...authHeaders } },
      ),
    );

    expect(comment.body).toBe("please prioritize the login flow");
    expect(comment.workItemId).toBe(workItem.id);
    expect(comment.isPinned).toBe(false);
    expect(comment.id).toBeDefined();
    // Author username is resolved at read time from `authorUserId` and returned
    // on the contract; the id remains the identity of record (decision D4).
    expect(comment.authorUsername).toBe(ownerUsername ?? "");
  });

  serialTest("lists comments for the work item", async () => {
    if (!workItem || !authHeaders || !comment) {
      throw new Error("setup incomplete");
    }

    const comments = await unwrapAsync(
      apiClient.api["work-item-comments"].get({
        query: { workItemId: parseWorkItemId(workItem.id) },
        headers: { ...authHeaders },
      }),
    );

    expect(comments).toHaveLength(1);
    expect(comments[0]?.id).toBe(comment.id);
    expect(comments[0]?.authorUsername).toBe(ownerUsername ?? "");
  });

  serialTest(
    "comments stay out of the agent step input, which holds only its args",
    async () => {
      if (!project || !workItem || !authHeaders) {
        throw new Error("setup incomplete");
      }

      const inputJson = await runFirstStepAndLoadInput(
        apiClient,
        authHeaders,
        parseUuidV7(project.id),
        parseUuidV7(workItem.id),
      );

      expect(inputJson).toEqual({ subject: "Commentable work item" });
    },
    30_000,
  );

  serialTest("pins the comment (team-wide)", async () => {
    if (!authHeaders || !comment) throw new Error("setup incomplete");

    const pinned = await unwrapAsync(
      apiClient.api["work-item-comments"]({ commentId: comment.id }).pin.post(
        { isPinned: true },
        { headers: { ...authHeaders } },
      ),
    );

    expect(pinned.isPinned).toBe(true);
    comment = pinned;
  });

  serialTest(
    "pinned comments stay out of the agent step input too",
    async () => {
      if (!project || !workItem || !authHeaders) {
        throw new Error("setup incomplete");
      }

      const inputJson = await runFirstStepAndLoadInput(
        apiClient,
        authHeaders,
        parseUuidV7(project.id),
        parseUuidV7(workItem.id),
      );

      expect(inputJson).toEqual({ subject: "Commentable work item" });
    },
    30_000,
  );

  serialTest("edits the comment body", async () => {
    if (!authHeaders || !comment) throw new Error("setup incomplete");

    const edited = await unwrapAsync(
      apiClient.api["work-item-comments"]({ commentId: comment.id }).patch(
        { body: "actually, focus on the signup flow" },
        { headers: { ...authHeaders } },
      ),
    );

    expect(edited.body).toBe("actually, focus on the signup flow");
    expect(edited.id).toBe(comment.id);
    comment = edited;
  });

  serialTest("unpins the comment", async () => {
    if (!authHeaders || !comment) throw new Error("setup incomplete");

    const unpinned = await unwrapAsync(
      apiClient.api["work-item-comments"]({ commentId: comment.id }).pin.post(
        { isPinned: false },
        { headers: { ...authHeaders } },
      ),
    );

    expect(unpinned.isPinned).toBe(false);
  });

  serialTest("deletes the comment", async () => {
    if (!authHeaders || !comment) throw new Error("setup incomplete");

    const deletedCount = await unwrapAsync(
      apiClient.api["work-item-comments"]({ commentId: comment.id }).delete(
        undefined,
        { headers: { ...authHeaders } },
      ),
    );

    expect(deletedCount).toBe(1);
  });

  serialTest("lists no comments after deletion", async () => {
    if (!workItem || !authHeaders) throw new Error("setup incomplete");

    const comments = await unwrapAsync(
      apiClient.api["work-item-comments"].get({
        query: { workItemId: parseWorkItemId(workItem.id) },
        headers: { ...authHeaders },
      }),
    );

    expect(comments).toHaveLength(0);
  });

  serialTest(
    "a non-author without comments:write cannot delete another user's comment",
    async () => {
      if (!project || !workItem || !authHeaders) {
        throw new Error("setup incomplete");
      }

      // Owner creates a comment.
      const ownerComment = await unwrapAsync(
        apiClient.api["work-item-comments"].post(
          {
            workItemId: parseWorkItemId(workItem.id),
            body: "owner-only comment",
          },
          { headers: { ...authHeaders } },
        ),
      );

      // A second user with NO access to the project attempts to delete it.
      const outsider = await createTestUserAndSession({
        email: `outsider-${crypto.randomUUID()}@example.com`,
      });

      const { error } = await apiClient.api["work-item-comments"]({
        commentId: ownerComment.id,
      }).delete(undefined, { headers: { ...outsider.authHeaders } });

      expect(error).toBeDefined();
      expect(error?.status === 403 || error?.status === 404).toBe(true);

      // The comment still exists for the owner.
      const stillThere = await unwrapAsync(
        apiClient.api["work-item-comments"].get({
          query: { workItemId: parseWorkItemId(workItem.id) },
          headers: { ...authHeaders },
        }),
      );
      expect(stillThere.some((c) => c.id === ownerComment.id)).toBe(true);
    },
  );

  serialTest("a non-author cannot edit another user's comment", async () => {
    if (!workItem || !authHeaders) throw new Error("setup incomplete");

    const ownerComments = await unwrapAsync(
      apiClient.api["work-item-comments"].get({
        query: { workItemId: parseWorkItemId(workItem.id) },
        headers: { ...authHeaders },
      }),
    );
    const ownerComment = ownerComments[ownerComments.length - 1];
    if (!ownerComment) throw new Error("expected an owner comment");

    const outsider = await createTestUserAndSession({
      email: `outsider-edit-${crypto.randomUUID()}@example.com`,
    });

    const { error } = await apiClient.api["work-item-comments"]({
      commentId: ownerComment.id,
    }).patch({ body: "hijacked" }, { headers: { ...outsider.authHeaders } });

    expect(error).toBeDefined();
    expect(error?.status === 403 || error?.status === 404).toBe(true);
  });

  serialTest(
    "returns an empty list for a work item in another project",
    async () => {
      if (!authHeaders) throw new Error("setup incomplete");

      const otherProject = await unwrapAsync(
        apiClient.api.projects.post(
          {
            name: "Other Comment Project",
            description: "Isolation check",
            gitUrl: "https://github.com/example/other-comment-project.git",
          },
          { headers: { ...authHeaders } },
        ),
      );
      const otherWorkItem = await unwrapAsync(
        apiClient.api["work-items"].post(
          {
            projectId: otherProject.id,
            platform: "github",
            platformId: `other-wi-${crypto.randomUUID()}`,
            platformKey: `#other-${crypto.randomUUID()}`,
            url: "https://github.com/example/repo/issues/2",
            title: "Other work item",
            description: "No comments here",
            sourceCreatedAt: null,
            sourceUpdatedAt: null,
            fields: {},
          },
          { headers: { ...authHeaders } },
        ),
      );

      const comments = await unwrapAsync(
        apiClient.api["work-item-comments"].get({
          query: { workItemId: parseWorkItemId(otherWorkItem.id) },
          headers: { ...authHeaders },
        }),
      );

      expect(comments).toHaveLength(0);
    },
  );
});
