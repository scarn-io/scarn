import { describe, expect } from "bun:test";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { taskGrantRequests, taskRuns } from "@/lib/db/schema";
import {
  GRANTS_ADDED_HEADING,
  REQUEST_ACCESS_PROMPT_LINE,
} from "@/tasks/task-run/application/task-run-worker-context-grant-requests";
import { NO_ANSWER_TEXT } from "@/tasks/task-run/application/task-run-worker-context-conversation";
import type { Grant } from "@/tasks/task/domain/grants";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { concurrentTest, unwrapAsync } from "tests/utils";
import { grant } from "tests/tasks/task/grants-test-support";
import {
  createHandOverHarness,
  trackingObjectStore,
} from "./hand-over-test-support";

const CLOSE_SECTION =
  "## Work Items: Close Your Work Item\n\nYou may close your work item. Use the `scarn-close-work-item` tool.";

/**
 * After a person decides a grant request, the continuation's worker context
 * tells the agent: the restored session's next message carries the decision,
 * and the fallback prompt lists the grants added during the Task.
 */
describe("a grant request decision in the worker context", () => {
  const objectStore = trackingObjectStore();
  const {
    appContext,
    apiClient,
    requireSetup,
    seedItem,
    claim,
    startTask,
    workerContext,
    conversationRoutes,
    loadTask,
  } = createHandOverHarness({
    objectStore: objectStore.store,
    grants: [grant("read", "self")],
    grantRequests: true,
  });

  /** A Task whose first run handed over with a saved session and a request for `grants`. */
  const requested = async (grants: Grant[]) => {
    const workItemId = await seedItem();
    const { taskId, taskRunId } = await startTask(workItemId, "conversation");
    const claimToken = await claim(workItemId, taskRunId);
    const routes = apiClient.api["task-runs"]({ taskRunId });
    const { headers } = requireSetup();
    const upload = await unwrapAsync(
      routes["session-upload-url"].post(
        { claimToken, sizeBytes: 128 },
        { headers },
      ),
    );
    await unwrapAsync(
      routes.yields.post(
        {
          claimToken,
          message: "I need more access.",
          sessionObjectKey: upload.objectKey,
          grantRequest: { reason: "To finish the job", grants },
        },
        { headers },
      ),
    );
    const [request] = await getDb()
      .select()
      .from(taskGrantRequests)
      .where(eq(taskGrantRequests.taskId, taskId));
    const conversationId = (await loadTask(taskId))?.conversationId;
    if (!request || !conversationId) {
      throw new Error("Expected a pending request and a conversation");
    }
    return {
      workItemId,
      taskId,
      requestId: request.id as UuidV7,
      conversationId: conversationId as UuidV7,
    };
  };

  const ownerName = async () => {
    const { ownerId } = requireSetup();
    return (
      (await appContext.usernameReader.loadUsernamesByUserId([ownerId])).get(
        ownerId,
      )?.username ?? "Someone"
    );
  };

  const continuationContext = async (workItemId: UuidV7, taskId: UuidV7) => {
    const run = (
      await getDb().select().from(taskRuns).where(eq(taskRuns.taskId, taskId))
    )
      .sort((left, right) => left.number - right.number)
      .at(-1);
    if (run?.reason !== "continuation") {
      throw new Error("Expected a continuation run");
    }
    return await workerContext(run.id, await claim(workItemId, run.id));
  };

  concurrentTest(
    "a decided request reaches the restored session and the fallback prompt",
    async () => {
      const { workItemId, taskId, requestId } = await requested([
        grant("close", "self"),
        grant("comment", "self"),
      ]);
      await unwrapAsync(
        apiClient.api["task-grant-requests"]({
          grantRequestId: requestId,
        }).decision.post(
          { approved: [grant("close", "self")], note: "Close it when done." },
          { headers: requireSetup().headers },
        ),
      );

      const context = await continuationContext(workItemId, taskId);
      const name = await ownerName();

      expect(context.task.grantRequests).toBe(true);
      expect(context.task.grants).toContainEqual(grant("close", "self"));
      const message = context.restoreSession?.message ?? "";
      expect(message).toStartWith(`${name} answered your access request.`);
      expect(message).toContain(`Granted:\n\n${CLOSE_SECTION}`);
      expect(message).toContain("Not granted: Comment on your work item.");
      expect(message).toContain(`Note from ${name}: Close it when done.`);
      expect(message).not.toContain("approved 1 of 2");
      expect(message).not.toContain(NO_ANSWER_TEXT);
      expect(context.agentPrompt.promptText).toContain(
        `${GRANTS_ADDED_HEADING}\n\n${name} answered your access request.`,
      );
    },
  );

  concurrentTest(
    "the first run's prompt points the agent at scarn-request-access",
    async () => {
      const workItemId = await seedItem();
      const { taskRunId } = await startTask(workItemId);

      const context = await workerContext(
        taskRunId,
        await claim(workItemId, taskRunId),
      );

      expect(context.agentPrompt.promptText).toContain(
        REQUEST_ACCESS_PROMPT_LINE,
      );
    },
  );

  concurrentTest(
    "Continue without deciding tells the agent nothing was granted",
    async () => {
      const { workItemId, taskId, conversationId } = await requested([
        grant("close", "self"),
      ]);
      await unwrapAsync(
        conversationRoutes(conversationId).continue.post(undefined, {
          headers: requireSetup().headers,
        }),
      );

      const context = await continuationContext(workItemId, taskId);

      expect(context.restoreSession?.message).toBe(
        `Your access request wasn't answered; nothing was granted.\n\n${NO_ANSWER_TEXT}`,
      );
      expect(context.agentPrompt.promptText).not.toContain(
        GRANTS_ADDED_HEADING,
      );
    },
  );
});

describe("a Task that may not ask for grants", () => {
  const { seedItem, claim, startTask, workerContext } = createHandOverHarness({
    grants: [grant("read", "self")],
    grantRequests: false,
  });

  concurrentTest("its prompt has no scarn-request-access line", async () => {
    const workItemId = await seedItem();
    const { taskRunId } = await startTask(workItemId);

    const context = await workerContext(
      taskRunId,
      await claim(workItemId, taskRunId),
    );

    expect(context.task.grantRequests).toBe(false);
    expect(context.agentPrompt.promptText).not.toContain(
      "scarn-request-access",
    );
  });
});
