import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { taskRuns, workItemComments, workItems } from "@/lib/db/schema";
import { yieldClaimedTaskRunInputSchema } from "@/tasks/task-run/contracts/task-run-contracts";
import type { WorkItemChange } from "@/tasks/task/contracts/work-item-change-contracts";
import {
  createUuidV7,
  parseUuidV7,
  type UuidV7,
} from "@scarn/core/common/contracts/uuid-v7";
import { concurrentTest, unwrapAsync } from "tests/utils";
import { allGrants, grant } from "tests/tasks/task/grants-test-support";
import { createHandOverHarness } from "./hand-over-test-support";

const failure = { name: "AgentCrashed", message: "The agent crashed." };

const comment = (workItemId: UuidV7, body: string): WorkItemChange => ({
  kind: "comment",
  workItemId,
  body,
});

/**
 * The work item changes an agent records before it hands over are held on
 * its Task: checked at the yield, applied with the final run's when the Task
 * succeeds, and dropped when it fails or is cancelled.
 */
describe("work item changes held across a hand-over", () => {
  const {
    apiClient,
    requireSetup,
    seedItem,
    claim,
    startTask,
    yieldRun,
    completeRun,
    loadTask,
    conversationRoutes,
  } = createHandOverHarness({
    objectStore: null,
    grants: allGrants("self", ["a"]),
    grantRequests: true,
  });

  const latestRunOf = async (taskId: UuidV7) => {
    const run = (
      await getDb().select().from(taskRuns).where(eq(taskRuns.taskId, taskId))
    )
      .sort((left, right) => left.number - right.number)
      .at(-1);
    if (!run) {
      throw new Error("Expected a run");
    }
    return run;
  };

  const claimLatest = async (workItemId: UuidV7, taskId: UuidV7) => {
    const run = await latestRunOf(taskId);
    return { run, claimToken: await claim(workItemId, run.id) };
  };

  const commentsOf = async (workItemId: UuidV7) =>
    (
      await getDb()
        .select({ body: workItemComments.body })
        .from(workItemComments)
        .where(eq(workItemComments.workItemId, workItemId))
    )
      .map((each) => each.body)
      .sort();

  const heldOf = async (taskId: UuidV7) =>
    (await loadTask(taskId))?.heldWorkItemChangesJson;

  /** Starts a Task whose first run hands over with `changes`. */
  const handedOverWith = async (
    kind: "findings" | "conversation" | "retrying",
    changes: (workItemId: UuidV7) => WorkItemChange[],
  ) => {
    const workItemId = await seedItem();
    const { taskId, taskRunId } = await startTask(workItemId, kind);
    const yielded = await yieldRun(workItemId, taskRunId, {
      message: "v1 or v2?",
      workItemChanges: changes(workItemId),
    });
    return { workItemId, taskId, yielded };
  };

  const reply = async (taskId: UuidV7) => {
    const conversationId = (await loadTask(taskId))?.conversationId;
    if (!conversationId) {
      throw new Error("Expected the Task's conversation");
    }
    await unwrapAsync(
      conversationRoutes(parseUuidV7(conversationId)).messages.post(
        { body: "v2, please." },
        { headers: requireSetup().headers },
      ),
    );
  };

  concurrentTest(
    "changes yielded in one run apply with the final run's when the Task succeeds",
    async () => {
      const { workItemId, taskId, yielded } = await handedOverWith(
        "findings",
        (id) => [
          comment(id, "Before asking"),
          {
            kind: "describe",
            workItemId: id,
            description: "Sharper",
            descriptionVersion: 1,
          },
        ],
      );
      expect(yielded.status).toBe("yielded");
      expect(await heldOf(taskId)).toHaveLength(2);
      expect(await commentsOf(workItemId)).toEqual([]);

      await reply(taskId);
      const final = await claimLatest(workItemId, taskId);
      const completed = await completeRun(final.run.id, final.claimToken, {
        status: "succeeded",
        resultJson: { done: true },
        workItemChanges: [
          {
            kind: "describe",
            workItemId,
            description: "Sharper still",
            descriptionVersion: 2,
          },
          comment(workItemId, "After asking"),
        ],
      });

      expect(completed).toMatchObject({ status: "succeeded" });
      expect(await commentsOf(workItemId)).toEqual([
        "After asking",
        "Before asking",
      ]);
      const item = (
        await getDb()
          .select()
          .from(workItems)
          .where(eq(workItems.id, workItemId))
      )[0];
      expect(item).toMatchObject({
        description: "Sharper still",
        descriptionVersion: 3,
      });
      expect(await heldOf(taskId)).toEqual([]);
    },
  );

  concurrentTest(
    "a change the Task isn't granted fails the run at the yield",
    async () => {
      const other = await seedItem();
      const { workItemId, taskId, yielded } = await handedOverWith(
        "findings",
        (id) => [comment(id, "Mine"), comment(other, "Not mine")],
      );

      expect(yielded.status).toBe("failed");
      expect(yielded.errorJson).toMatchObject({
        name: "Scarn.WorkItemChangesInvalid",
      });
      expect((await loadTask(taskId))?.status).toBe("failed");
      expect(await heldOf(taskId)).toEqual([]);
      expect(await commentsOf(workItemId)).toEqual([]);
      expect(await commentsOf(other)).toEqual([]);
    },
  );

  concurrentTest("held changes survive a retry", async () => {
    const { workItemId, taskId } = await handedOverWith("retrying", (id) => [
      comment(id, "Before asking"),
    ]);
    await reply(taskId);
    const continuation = await claimLatest(workItemId, taskId);
    await completeRun(continuation.run.id, continuation.claimToken, {
      status: "failed",
      errorJson: failure,
    });
    expect(await heldOf(taskId)).toHaveLength(1);

    const retry = await claimLatest(workItemId, taskId);
    expect(retry.run.reason).toBe("retry");
    await completeRun(retry.run.id, retry.claimToken, {
      status: "succeeded",
      resultJson: { summary: "Done." },
    });

    expect((await loadTask(taskId))?.status).toBe("succeeded");
    expect(await commentsOf(workItemId)).toContain("Before asking");
    expect(await heldOf(taskId)).toEqual([]);
  });

  concurrentTest("held changes are dropped when the Task fails", async () => {
    const { workItemId, taskId } = await handedOverWith("findings", (id) => [
      comment(id, "Before asking"),
    ]);
    await reply(taskId);
    const continuation = await claimLatest(workItemId, taskId);
    await completeRun(continuation.run.id, continuation.claimToken, {
      status: "failed",
      errorJson: failure,
    });

    expect((await loadTask(taskId))?.status).toBe("failed");
    expect(await heldOf(taskId)).toEqual([]);
    expect(await commentsOf(workItemId)).toEqual([]);
  });

  concurrentTest(
    "held changes are dropped when the Task is cancelled",
    async () => {
      const { workItemId, taskId } = await handedOverWith("findings", (id) => [
        comment(id, "Before asking"),
      ]);
      expect(await heldOf(taskId)).toHaveLength(1);

      await unwrapAsync(
        apiClient.api.tasks({ taskId }).cancel.post(undefined, {
          headers: requireSetup().headers,
        }),
      );

      expect((await loadTask(taskId))?.status).toBe("cancelled");
      expect(await heldOf(taskId)).toEqual([]);
      expect(await commentsOf(workItemId)).toEqual([]);
    },
  );

  concurrentTest(
    "a yield that would hold more than 200 changes is refused",
    async () => {
      const comments = (id: UuidV7, count: number, prefix: string) =>
        Array.from({ length: count }, (_, index) =>
          comment(id, `${prefix} ${String(index)}`),
        );
      const { workItemId, taskId } = await handedOverWith("findings", (id) =>
        comments(id, 150, "first"),
      );
      expect(await heldOf(taskId)).toHaveLength(150);
      await reply(taskId);
      const continuation = await latestRunOf(taskId);

      const yielded = await yieldRun(workItemId, continuation.id, {
        message: "Again?",
        workItemChanges: comments(workItemId, 51, "second"),
      });

      expect(yielded.status).toBe("failed");
      expect(yielded.errorJson).toMatchObject({
        name: "Scarn.WorkItemChangesInvalid",
      });
      expect(await commentsOf(workItemId)).toEqual([]);
    },
  );

  concurrentTest(
    "a yield may carry a grant request alongside its changes",
    async () => {
      const workItemId = await seedItem();
      const { taskId, taskRunId } = await startTask(workItemId, "findings");
      const claimToken = await claim(workItemId, taskRunId);

      const yielded = await unwrapAsync(
        apiClient.api["task-runs"]({ taskRunId }).yields.post(
          {
            claimToken,
            message: "May I close it?",
            grantRequest: {
              reason: "Closing it needs the close grant.",
              grants: [grant("close", "self")],
            },
            workItemChanges: [comment(workItemId, "Looked at it")],
          },
          { headers: requireSetup().headers },
        ),
      );

      expect(yielded.status).toBe("yielded");
      expect(await heldOf(taskId)).toHaveLength(1);
    },
  );
});

describe("the yield contract", () => {
  const base = { claimToken: "token", message: "May I?" };

  test("accepts a grant request and work item changes", () => {
    const parsed = yieldClaimedTaskRunInputSchema.parse({
      ...base,
      grantRequest: { reason: "  Need it.  ", grants: [grant("read", "self")] },
      workItemChanges: [
        { kind: "comment", workItemId: createUuidV7(), body: "Hi" },
      ],
    });
    expect(parsed.grantRequest?.reason).toBe("Need it.");
    expect(parsed.workItemChanges).toHaveLength(1);
  });

  test("takes an empty message only with a grant request", () => {
    const grantRequest = {
      reason: "Need it.",
      grants: [grant("read", "self")],
    };
    expect(
      yieldClaimedTaskRunInputSchema.safeParse({ ...base, message: " " })
        .success,
    ).toBe(false);
    expect(
      yieldClaimedTaskRunInputSchema.safeParse({
        ...base,
        message: "",
        grantRequest,
      }).success,
    ).toBe(true);
  });

  test("refuses a grant request with no grants, too many, or no reason", () => {
    const refused = [
      { reason: "Need it.", grants: [] },
      {
        reason: "Need it.",
        grants: Array.from({ length: 21 }, () => grant("read", "self")),
      },
      { reason: " ", grants: [grant("read", "self")] },
      { reason: "x".repeat(2001), grants: [grant("read", "self")] },
    ];
    for (const grantRequest of refused) {
      expect(
        yieldClaimedTaskRunInputSchema.safeParse({ ...base, grantRequest })
          .success,
      ).toBe(false);
    }
  });
});
