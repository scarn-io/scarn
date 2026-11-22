import { createApp } from "@scarn/api/app";
import { parseUuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { createAppContext } from "@/lib/di";
import type { Grant } from "@/tasks/task/domain/grants";
import { parseWorkItemId } from "@/work-items/work-item/domain/work-item-id";
import { parseWorkItemCommentId } from "@/work-items/work-item-comment/domain/work-item-comment-id";
import { createScarnTreaty } from "tests/treaty";
import { unwrapAsync } from "tests/utils";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import { grant } from "./grants-test-support";

export const createCommentReadFixture = async () => {
  let now = new Date("2026-05-01T12:00:00.000Z");
  const api = createScarnTreaty(
    createApp(
      createAppContext({
        timeProvider: { now: () => now, nowIso: () => now.toISOString() },
      }),
    ),
  );
  const owner = await createTestUserAndSession({
    email: `comment-read-${crypto.randomUUID()}@example.com`,
  });
  const headers = { ...owner.authHeaders };
  const createProject = async () =>
    unwrapAsync(
      api.api.projects.post(
        {
          name: "Comment read project",
          description: "Claim-authorized comment coverage",
          gitUrl: "https://github.com/example/comment-read.git",
        },
        { headers },
      ),
    );
  const project = await createProject();
  const createItem = async (
    projectId = project.id,
    platform: "scarn" | "github" = "scarn",
  ) => {
    const item = await unwrapAsync(
      api.api["work-items"].post(
        {
          projectId,
          platform,
          platformId: `comment-read-${crypto.randomUUID()}`,
          platformKey: `comment-read-${crypto.randomUUID()}`,
          url: null,
          title: "Comment reader subject",
          description: "Read live comments",
          sourceCreatedAt: null,
          sourceUpdatedAt: null,
          fields:
            platform === "github"
              ? { repository: "example/comment-read", number: 1 }
              : {},
        },
        { headers },
      ),
    );
    return parseWorkItemId(item.id);
  };
  const item = await createItem();
  const post = async (
    body: string,
    workItemId = item,
    parentCommentId?: string,
  ) => {
    const posted = await unwrapAsync(
      api.api["work-item-comments"].post(
        {
          workItemId,
          body,
          ...(parentCommentId
            ? { parentCommentId: parseWorkItemCommentId(parentCommentId) }
            : {}),
        },
        { headers },
      ),
    );
    return { ...posted, id: parseWorkItemCommentId(posted.id) };
  };
  const claim = async (
    workItemId = item,
    grants: Grant[] = [grant("read", "self")],
  ) => {
    const step = await unwrapAsync(
      api.api["step-definitions"].post(
        {
          projectId: project.id,
          key: `comment_read_${crypto.randomUUID()}`,
          name: "Comment reader",
          description: "Comment reader",
          prompt: "Read comments",
          version: 1,
          kind: "user_defined",
          inputSchemaJson: { type: "object" },
          resultSchemaJson: { type: "object" },
          status: "active",
          repo: { mode: "readOnly" },
          grants,
        },
        { headers },
      ),
    );
    const started = await unwrapAsync(
      api.api.tasks.post(
        {
          projectId: project.id,
          workItemId: parseUuidV7(workItemId),
          stepDefinitionId: parseUuidV7(step.id),
          stepDefinitionVersion: step.version,
        },
        { headers },
      ),
    );
    if (!started.run) throw new Error("Expected a first run");
    const claims = await unwrapAsync(
      api.api["task-runs"].claims.post(
        {
          projectId: project.id,
          workItemId,
          workerId: `comment-read-${crypto.randomUUID()}`,
          batchSize: 1,
          leaseDurationSeconds: 30,
        },
        { headers },
      ),
    );
    const claimed = claims.find((entry) => entry.task.id === started.run?.id);
    if (!claimed) throw new Error("Expected claimed run");
    const run = api.api["task-runs"]({ taskRunId: claimed.task.id });
    const read = (
      target = workItemId,
      commentsCursor?: string,
      claimToken = claimed.claimToken,
    ) =>
      run["work-item-reads"].post({
        claimToken,
        workItemId: target,
        ...(commentsCursor ? { commentsCursor } : {}),
      });
    return { ...claimed, run, read };
  };
  return {
    api,
    headers,
    owner,
    project,
    item,
    createItem,
    createProject,
    post,
    claim,
    advance: (milliseconds: number) => {
      now = new Date(now.getTime() + milliseconds);
    },
  };
};
