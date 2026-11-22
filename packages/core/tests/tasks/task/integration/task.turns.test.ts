import { describe, expect } from "bun:test";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { taskRuns } from "@/lib/db/schema";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { concurrentTest, unwrapAsync } from "tests/utils";
import { createHandOverHarness } from "./hand-over-test-support";

/**
 * A standalone Task's turns: its step definition's `maxTurns`, else 20, and
 * a person's reply grants one more when none are left.
 */
describe("standalone Task turns", () => {
  const {
    apiClient,
    requireSetup,
    seedItem,
    claim,
    workerContext,
    loadTask,
    handedOver,
    conversationRoutes,
  } = createHandOverHarness();

  const reply = async (conversationId: UuidV7, body: string) =>
    await unwrapAsync(
      conversationRoutes(conversationId).messages.post(
        { body },
        { headers: requireSetup().headers },
      ),
    );

  const runNumbered = async (taskId: UuidV7, number: number) => {
    const [run] = await getDb()
      .select()
      .from(taskRuns)
      .where(and(eq(taskRuns.taskId, taskId), eq(taskRuns.number, number)));
    if (!run) {
      throw new Error(`Expected run ${String(number)}`);
    }
    return run;
  };

  concurrentTest(
    "a reply with no turns left grants one, so the continuation can hand over again",
    async () => {
      const { workItemId, taskId, conversationId } =
        await handedOver("oneTurn");
      expect((await loadTask(taskId))?.maxTurns).toBe(1);

      await reply(conversationId, "Keep going.");

      expect((await loadTask(taskId))?.maxTurns).toBe(2);
      const continuation = await runNumbered(taskId, 2);
      const claimToken = await claim(workItemId, continuation.id);
      const context = await workerContext(continuation.id, claimToken);
      expect(context.task.turnsRemaining).toBe(1);

      await unwrapAsync(
        apiClient.api["task-runs"]({ taskRunId: continuation.id }).yields.post(
          { claimToken, message: "Anything else?" },
          { headers: requireSetup().headers },
        ),
      );

      const task = await loadTask(taskId);
      expect(task?.status).toBe("waiting_for_person");
      expect(task?.errorJson).toBeNull();

      await reply(conversationId, "One more thing.");

      expect((await loadTask(taskId))?.maxTurns).toBe(3);
    },
  );

  concurrentTest("a reply with turns left grants none", async () => {
    const { taskId, conversationId } = await handedOver("conversation");

    await reply(conversationId, "Go on.");

    expect((await loadTask(taskId))?.maxTurns).toBe(20);
  });

  concurrentTest("a prompt Task gets the default 20 turns", async () => {
    const { projectId, headers } = requireSetup();
    const created = await unwrapAsync(
      apiClient.api.tasks.post(
        {
          projectId,
          workItemId: await seedItem(),
          prompt: "Talk it through.",
          inputJson: null,
        },
        { headers },
      ),
    );

    expect(created.task.maxTurns).toBe(20);
  });
});
