import { describe, expect } from "bun:test";
import { createApp } from "@scarn/api/app";
import { parseUuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { createAppContext } from "@/lib/di";
import { parseWorkItemId } from "@/work-items/work-item/domain/work-item-id";
import { createScarnTreaty } from "tests/treaty";
import { concurrentTest, fixedTimeProvider, unwrapAsync } from "tests/utils";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import { grant } from "tests/tasks/task/grants-test-support";

describe("task run work item comments", () => {
  const apiClient = createScarnTreaty(
    createApp(
      createAppContext({
        timeProvider: fixedTimeProvider(new Date("2026-05-01T12:00:00.000Z")),
      }),
    ),
  );

  concurrentTest(
    "a claimed Task reads its work item's posted comment body without a user session",
    async () => {
      const owner = await createTestUserAndSession({
        email: `task-work-item-comments-${crypto.randomUUID()}@example.com`,
      });
      const headers = { ...owner.authHeaders };
      const project = await unwrapAsync(
        apiClient.api.projects.post(
          {
            name: "Task Work Item Comments Project",
            description: "Project for claim-authorized comment reads",
            gitUrl: "https://github.com/example/test-project.git",
          },
          { headers },
        ),
      );
      const projectId = parseUuidV7(project.id);
      const item = await unwrapAsync(
        apiClient.api["work-items"].post(
          {
            projectId,
            platform: "github",
            platformId: `task-comment-${crypto.randomUUID()}`,
            platformKey: `#task-comment-${crypto.randomUUID()}`,
            url: "https://github.com/example/test-project/issues/1",
            title: "Investigate the export failure",
            description: "Use the posted findings to diagnose the failure.",
            sourceCreatedAt: null,
            sourceUpdatedAt: null,
            fields: {},
          },
          { headers },
        ),
      );
      const workItemId = parseWorkItemId(item.id);
      const body = "The CSV export fails when a column contains a newline.";
      const posted = await unwrapAsync(
        apiClient.api["work-item-comments"].post(
          { workItemId, body },
          { headers },
        ),
      );
      expect(posted.body).toBe(body);

      const step = await unwrapAsync(
        apiClient.api["step-definitions"].post(
          {
            projectId,
            key: `task_work_item_comments_${crypto.randomUUID()}`,
            name: "Read posted findings",
            description: "Step for claim-authorized comment reads",
            prompt: "Read the work item and its posted findings.",
            version: 1,
            kind: "user_defined",
            inputSchemaJson: { type: "object" },
            resultSchemaJson: { type: "object" },
            status: "active",
            repo: { mode: "readOnly" },
            grants: [grant("read", "self")],
          },
          { headers },
        ),
      );
      const task = await unwrapAsync(
        apiClient.api.tasks.post(
          {
            projectId,
            workItemId: parseUuidV7(workItemId),
            stepDefinitionId: parseUuidV7(step.id),
            stepDefinitionVersion: step.version,
          },
          { headers },
        ),
      );
      if (!task.run) {
        throw new Error("Expected the Task's first run");
      }
      const claims = await unwrapAsync(
        apiClient.api["task-runs"].claims.post(
          {
            projectId,
            workItemId,
            workerId: `work-item-comments-${crypto.randomUUID()}`,
            batchSize: 1,
            leaseDurationSeconds: 30,
          },
          { headers },
        ),
      );
      const claim = claims.find((entry) => entry.task.id === task.run?.id);
      if (!claim) {
        throw new Error(`Expected to claim run ${task.run.id}`);
      }

      const read = await unwrapAsync(
        apiClient.api["task-runs"]({ taskRunId: claim.task.id })[
          "work-item-reads"
        ].post({ claimToken: claim.claimToken, workItemId }),
      );

      expect(read.comments.items.map((comment) => comment.body)).toContain(body);
    },
    30_000,
  );
});
