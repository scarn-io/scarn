import { describe, expect } from "bun:test";
import { eq } from "drizzle-orm";
import { ConversationEntity } from "@/conversations/conversation/domain/conversation-entity";
import { DrizzleConversationRepo } from "@/conversations/conversation/infra/drizzle-conversation-repo";
import { parseUuidV7 } from "@/common/contracts/uuid-v7";
import { getDb } from "@/lib/db";
import { userNotifications } from "@/lib/db/schema";
import { TaskEntity } from "@/tasks/task/domain/task-entity";
import { DrizzleTaskRepo } from "@/tasks/task/infra/drizzle-task-repo";
import { DrizzleTaskRunRepo } from "@/tasks/task-run/infra/drizzle-task-run-repo";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import { fixedTimeProvider, serialTest, unwrapAsync } from "tests/utils";
import { createHandOverHarness } from "./hand-over-test-support";

const NOW = new Date("2026-01-01T12:00:00.000Z");

const taskRepo = new DrizzleTaskRepo();
const taskRunRepo = new DrizzleTaskRunRepo(fixedTimeProvider(NOW));
const conversationRepo = new DrizzleConversationRepo();

describe("a chat: a Task without a work item", () => {
  const { apiClient, requireSetup, loadTask, workerContext } =
    createHandOverHarness();

  /** A queued chat Task started by `startedByUserId`, with its first run. */
  const seedChat = async (startedByUserId = requireSetup().ownerId) => {
    const { projectId } = requireSetup();
    const conversation = await conversationRepo.create(
      ConversationEntity.start({ projectId, workItemId: null, now: NOW }),
    );
    const task = await taskRepo.create(
      TaskEntity.create({
        projectId,
        workItemId: null,
        conversationId: conversation.id,
        kind: "agent",
        prompt: "How does checkout work?",
        grants: [{ resource: "workItem", action: "read", scope: "self" }],
        startedByUserId,
        status: "queued",
        createdAt: NOW,
      }),
    );
    const run = await taskRunRepo.create(
      task.newRun({
        number: 1,
        reason: "initial",
        status: "queued",
        now: NOW,
      }),
    );
    return { task, run, conversationId: conversation.id };
  };

  const claimRun = async (taskRunId: string) => {
    const { projectId, headers } = requireSetup();
    const claims = await unwrapAsync(
      apiClient.api["task-runs"].claims.post(
        {
          projectId,
          workerId: `chat-${crypto.randomUUID()}`,
          batchSize: 20,
          leaseDurationSeconds: 30,
        },
        { headers },
      ),
    );
    const claimToken = claims.find(
      (each) => each.task.id === taskRunId,
    )?.claimToken;
    if (!claimToken) {
      throw new Error("Expected to claim the chat's run");
    }
    return claimToken;
  };

  serialTest("has no grants, not even read on self", async () => {
    const { task } = await seedChat();

    expect(task.grants).toEqual([]);
    expect((await taskRepo.load(task.id))?.grants).toEqual([]);
  });

  serialTest(
    "appears in the project's Task summaries with no work item",
    async () => {
      const { projectId, headers } = requireSetup();
      const { task } = await seedChat();

      const listed = await unwrapAsync(
        apiClient.api.projects({ projectId }).tasks.get({ query: {}, headers }),
      );
      expect(listed.tasks.find((each) => each.id === task.id)).toMatchObject({
        workItem: null,
        conversationId: task.conversationId,
      });
      expect(listed.counts.queued).toBeGreaterThanOrEqual(1);

      const detail = await unwrapAsync(
        apiClient.api.tasks({ taskId: task.id }).get({ headers }),
      );
      expect(detail).toMatchObject({ workItemId: null, workItem: null });
    },
  );

  serialTest(
    "gets a worker context with no work item and no work-item instruction",
    async () => {
      const { run } = await seedChat();
      const claimToken = await claimRun(run.id);

      const context = await workerContext(run.id, claimToken);

      expect(context.task.workItemId).toBeNull();
      expect(context.task.grants).toEqual([]);
      expect(context.agentPrompt.promptText).not.toContain("Work item id");
      expect(context.agentPrompt.promptText).not.toContain(
        "scarn-get-work-item",
      );
      expect(context.agentPrompt.promptText).not.toContain("work item id");
    },
  );

  serialTest("a hand-over notifies only the Task's starter", async () => {
    const other = await createTestUserAndSession({
      email: `chat-starter-${crypto.randomUUID()}@example.com`,
    });
    const { task, run, conversationId } = await seedChat(
      parseUuidV7(other.userId),
    );
    const claimToken = await claimRun(run.id);
    await unwrapAsync(
      apiClient.api["task-runs"]({ taskRunId: run.id }).yields.post(
        { claimToken, message: "It goes through the cart service." },
        { headers: requireSetup().headers },
      ),
    );

    expect((await loadTask(task.id))?.status).toBe("waiting_for_person");
    const notified = await getDb()
      .select()
      .from(userNotifications)
      .where(eq(userNotifications.taskId, task.id));
    expect(notified).toHaveLength(1);
    expect(notified[0]).toMatchObject({
      kind: "result_ready",
      recipientUserId: other.userId,
      workItemId: null,
      payloadJson: { conversationId },
    });
  });
});
