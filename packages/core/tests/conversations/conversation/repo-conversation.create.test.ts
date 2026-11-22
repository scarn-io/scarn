/**
 * DB-backed coverage for repo conversations (chats). In neither `unit/` (it
 * hits Postgres) nor `integration/` (they also read and seed
 * the database directly; route-level tests are in `integration/`).
 */
import { describe, expect } from "bun:test";
import { eq } from "drizzle-orm";
import { parseUuidV7 } from "@/common/contracts/uuid-v7";
import { getDb } from "@/lib/db";
import {
  conversationMessages,
  pipelineRuns,
  projects,
  workItems,
} from "@/lib/db/schema";
import { serialTest, unwrapAsync } from "tests/utils";
import { createRepoConversationHarness } from "./repo-conversation-test-support";

describe("repo conversations: creating", () => {
  const { h, create, created, member, statusOf, runsOf, conversationOf } =
    createRepoConversationHarness();

  serialTest(
    "opens a pending conversation with the question and a queued chat Task, without a work item or pipeline",
    async () => {
      const { projectId, ownerId } = h.requireSetup();
      const countItems = async () =>
        (
          await getDb()
            .select()
            .from(workItems)
            .where(eq(workItems.projectId, projectId))
        ).length;
      const itemsBefore = await countItems();

      const chat = await created("Where is the retry policy applied?");

      expect(await countItems()).toBe(itemsBefore);
      expect(
        await getDb()
          .select()
          .from(pipelineRuns)
          .where(eq(pipelineRuns.projectId, projectId)),
      ).toEqual([]);

      const conversation = await conversationOf(
        parseUuidV7(chat.conversationId),
      );
      expect(conversation).toMatchObject({
        workItemId: null,
        status: "reply_pending",
        closedAt: null,
      });
      expect(
        conversation.messages.map(({ authorKind, body }) => ({
          authorKind,
          body,
        })),
      ).toEqual([
        {
          authorKind: "person",
          body: "Where is the retry policy applied?",
        },
      ]);

      const task = await h.loadTask(parseUuidV7(chat.taskId));
      expect(task).toMatchObject({
        workItemId: null,
        conversationId: chat.conversationId,
        kind: "agent",
        grants: [],
        maxTurns: 20,
        startedByUserId: ownerId,
        status: "queued",
        stepDefinitionId: null,
        resultSchemaJson: null,
      });
      expect(task?.prompt).not.toContain("Where is the retry policy applied?");
      const config = await h.appContext.taskExecutionConfigRepo.load(
        parseUuidV7(task?.taskExecutionConfigId ?? ""),
      );
      expect(config?.git).toEqual({
        mode: "readOnly",
        gitCredentials: "none",
        baseBranch: null,
      });

      const runs = await runsOf(chat.taskId);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({
        id: chat.taskRunId,
        number: 1,
        reason: "initial",
        status: "queued",
        baseBranch: null,
        workItemId: null,
      });
    },
  );

  serialTest("a second chat on the project reuses its config row", async () => {
    const first = await created();
    const second = await created();
    const [one, two] = await Promise.all([
      h.loadTask(parseUuidV7(first.taskId)),
      h.loadTask(parseUuidV7(second.taskId)),
    ]);
    expect(two?.taskExecutionConfigId).toBe(one?.taskExecutionConfigId ?? "");
  });

  serialTest(
    "with no worker, the question stays queued with nothing delivered",
    async () => {
      const chat = await created();
      const [run] = await runsOf(chat.taskId);
      expect(run?.status).toBe("queued");
      const messages = await getDb()
        .select()
        .from(conversationMessages)
        .where(eq(conversationMessages.conversationId, chat.conversationId));
      expect(messages.map((each) => each.deliveredToTaskRunId)).toEqual([null]);
    },
  );

  serialTest(
    "needs executions:write, and creates nothing without it",
    async () => {
      const reader = await member("read");
      const messagesBy = async () =>
        (
          await getDb()
            .select()
            .from(conversationMessages)
            .where(eq(conversationMessages.authorUserId, reader))
        ).length;
      const before = await messagesBy();

      expect(await statusOf(create("Can I ask?", reader))).toEqual({
        status: 403,
        code: "PROJECT_FORBIDDEN",
      });
      expect(await messagesBy()).toBe(before);
    },
  );

  serialTest("is refused with 422 when the project has no repo", async () => {
    const { ownerId, headers } = h.requireSetup();
    const repoless = await unwrapAsync(
      h.apiClient.api.projects.post(
        {
          name: `Repoless ${crypto.randomUUID()}`,
          description: "No repo",
          gitUrl: "https://github.com/example/repoless.git",
        },
        { headers },
      ),
    );
    const projectId = parseUuidV7(repoless.id);
    await getDb()
      .update(projects)
      .set({ gitUrl: "" })
      .where(eq(projects.id, projectId));

    const refused = await statusOf(create("Anything?", ownerId, projectId));
    expect(refused.status).toBe(422);
  });
});
