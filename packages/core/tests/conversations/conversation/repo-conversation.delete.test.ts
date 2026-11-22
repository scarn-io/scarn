/**
 * DB-backed coverage for deleting repo conversations (chats): what the
 * transaction removes, the storage sweeps and object deletes it leaves
 * behind, what late worker calls see, and races with a reply, a claim and a
 * yield.
 * In neither `unit/` (it hits Postgres) nor `integration/` (they also read
 * the database directly; route-level tests are in `integration/`).
 */
import { describe, expect } from "bun:test";
import { eq, inArray, or, sql } from "drizzle-orm";
import { createUuidV7, parseUuidV7 } from "@/common/contracts/uuid-v7";
import { getDb } from "@/lib/db";
import {
  agentSessions,
  conversationMessages,
  conversations,
  storageSweeps,
  taskArtifacts,
  taskLogLines,
  taskRuns,
  tasks,
  userNotifications,
} from "@/lib/db/schema";
import { serialTest } from "tests/utils";
import {
  createRepoConversationHarness,
  PresigningObjectStore,
  SESSION_BYTES,
  unwrap,
} from "./repo-conversation-test-support";

describe("repo conversations: deleting", () => {
  const objectStore = new PresigningObjectStore();
  const {
    h,
    remove,
    created,
    statusOf,
    claim,
    answer,
    answerWithSession,
    fail,
    runsOf,
    reply,
    retainedSessionBytes,
  } = createRepoConversationHarness({ objectStore });

  const deleted = async (conversationId: string) => {
    await unwrap(remove(conversationId));
  };

  const objectKeys = (taskRunId: string) => {
    const { projectId } = h.requireSetup();
    return [
      `tasks/${taskRunId}/session.jsonl`,
      `step-executions/${taskRunId}/log.ndjson`,
      `artifacts/${projectId}/${taskRunId}/report.md`,
    ];
  };

  /** Gives each run log lines, an artifact, an agent session and stored objects, and the chat notifications. */
  const seed = async (chat: { taskId: string; conversationId: string }) => {
    const { projectId } = h.requireSetup();
    const db = getDb();
    const now = new Date();
    for (const run of await runsOf(chat.taskId)) {
      await db.insert(taskLogLines).values({
        id: createUuidV7(),
        taskRunId: run.id,
        seq: 1,
        stream: "worker",
        ts: now,
        content: "thinking",
      });
      await db.insert(taskArtifacts).values({
        id: createUuidV7(),
        taskRunId: run.id,
        projectId,
        relativeStorePath: "report.md",
        objectKey: `artifacts/${projectId}/${run.id}/report.md`,
        sizeBytes: 1,
      });
      await db.insert(agentSessions).values({
        id: createUuidV7(),
        taskRunId: run.id,
        provider: "claude",
        externalSessionId: `chat-${crypto.randomUUID()}`,
        status: "ended",
        startedAt: now,
      });
      for (const key of objectKeys(run.id)) {
        await objectStore.putObject({ key, body: "x" });
      }
    }
    const notification = {
      projectId,
      kind: "result_ready" as const,
      audience: "specific_users" as const,
      title: "Your chat replied",
      body: "Open it",
      source: "system" as const,
      createdAt: now,
      updatedAt: now,
    };
    await db.insert(userNotifications).values([
      { ...notification, id: createUuidV7(), taskId: chat.taskId },
      {
        ...notification,
        id: createUuidV7(),
        payloadJson: { conversationId: chat.conversationId },
      },
    ]);
  };

  const leftovers = async (
    chat: { taskId: string; conversationId: string },
    runIds: string[],
  ) => {
    const db = getDb();
    const count = async (rows: PromiseLike<unknown[]>) => (await rows).length;
    return {
      tasks: await count(
        db.select().from(tasks).where(eq(tasks.id, chat.taskId)),
      ),
      taskRuns: await count(
        db.select().from(taskRuns).where(inArray(taskRuns.id, runIds)),
      ),
      taskLogLines: await count(
        db
          .select()
          .from(taskLogLines)
          .where(inArray(taskLogLines.taskRunId, runIds)),
      ),
      agentSessions: await count(
        db
          .select()
          .from(agentSessions)
          .where(inArray(agentSessions.taskRunId, runIds)),
      ),
      taskArtifacts: await count(
        db
          .select()
          .from(taskArtifacts)
          .where(inArray(taskArtifacts.taskRunId, runIds)),
      ),
      conversationMessages: await count(
        db
          .select()
          .from(conversationMessages)
          .where(eq(conversationMessages.conversationId, chat.conversationId)),
      ),
      conversations: await count(
        db
          .select()
          .from(conversations)
          .where(eq(conversations.id, chat.conversationId)),
      ),
      userNotifications: await count(
        db
          .select()
          .from(userNotifications)
          .where(
            or(
              eq(userNotifications.taskId, chat.taskId),
              sql`${userNotifications.payloadJson}->>'conversationId' = ${chat.conversationId}`,
            ),
          ),
      ),
    };
  };

  const NOTHING_LEFT = {
    tasks: 0,
    taskRuns: 0,
    taskLogLines: 0,
    agentSessions: 0,
    taskArtifacts: 0,
    conversationMessages: 0,
    conversations: 0,
    userNotifications: 0,
  };

  const sweepsPerRun = async (runIds: string[]) => {
    const rows = await getDb()
      .select()
      .from(storageSweeps)
      .where(inArray(storageSweeps.taskRunId, runIds));
    return runIds.map(
      (runId) => rows.filter((row) => row.taskRunId === runId).length,
    );
  };

  const expectGone = async (
    chat: { taskId: string; conversationId: string },
    runIds: string[],
  ) => {
    expect(await leftovers(chat, runIds)).toEqual(NOTHING_LEFT);
    expect(await sweepsPerRun(runIds)).toEqual(runIds.map(() => 1));
    for (const runId of runIds) {
      for (const key of objectKeys(runId)) {
        expect(await objectStore.getObject(key)).toBeNull();
      }
    }
  };

  const runIdsOf = async (taskId: string) =>
    (await runsOf(taskId)).map((run) => run.id);

  serialTest("from queued: removes everything", async () => {
    const chat = await created();
    await seed(chat);
    const runIds = await runIdsOf(chat.taskId);

    await deleted(chat.conversationId);

    await expectGone(chat, runIds);
  });

  serialTest("from running: removes everything", async () => {
    const chat = await created();
    await claim(chat.taskRunId);
    await seed(chat);
    const runIds = await runIdsOf(chat.taskId);

    await deleted(chat.conversationId);

    await expectGone(chat, runIds);
  });

  serialTest(
    "from waiting: removes everything and takes the session off the meter",
    async () => {
      const chat = await created();
      await answerWithSession(chat.taskRunId, "Here's how.");
      await seed(chat);
      const runIds = await runIdsOf(chat.taskId);
      const bytesBefore = await retainedSessionBytes();

      await deleted(chat.conversationId);

      await expectGone(chat, runIds);
      expect(bytesBefore - (await retainedSessionBytes())).toBe(SESSION_BYTES);
    },
  );

  serialTest("from failed: removes everything", async () => {
    const chat = await created();
    await fail(chat.taskRunId);
    await seed(chat);
    const runIds = await runIdsOf(chat.taskId);

    await deleted(chat.conversationId);

    await expectGone(chat, runIds);
  });

  serialTest("with a follow-up queued: one storage sweep per run", async () => {
    const chat = await created();
    await answer(chat.taskRunId, "First answer.");
    await reply(parseUuidV7(chat.conversationId), "And then?");
    await seed(chat);
    const runIds = await runIdsOf(chat.taskId);
    expect(runIds).toHaveLength(2);

    await deleted(chat.conversationId);

    await expectGone(chat, runIds);
  });

  serialTest("keeps other chats' notifications", async () => {
    const kept = await created("Keep me");
    const gone = await created("Delete me");
    await seed(kept);
    await seed(gone);

    await deleted(gone.conversationId);

    expect(
      (await leftovers(kept, await runIdsOf(kept.taskId))).userNotifications,
    ).toBe(2);
  });

  serialTest(
    "a deleted chat is 404 to a second delete and to a reply",
    async () => {
      const chat = await created();
      await deleted(chat.conversationId);

      expect(await statusOf(unwrap(remove(chat.conversationId)))).toEqual({
        status: 404,
        code: "CONVERSATION_NOT_FOUND",
      });
      expect(
        (await reply(parseUuidV7(chat.conversationId), "Hello?")).status,
      ).toBe(404);
    },
  );

  serialTest(
    "late worker calls on the deleted run are 404 and recreate nothing",
    async () => {
      const chat = await created();
      const claimToken = await claim(chat.taskRunId);
      const runIds = await runIdsOf(chat.taskId);
      await deleted(chat.conversationId);
      const routes = h.apiClient.api["task-runs"]({
        taskRunId: chat.taskRunId,
      });
      const { headers } = h.requireSetup();

      const statuses = [
        await routes.heartbeat.put(
          { claimToken, leaseDurationSeconds: 30 },
          { headers },
        ),
        await routes.logs.post(
          {
            claimToken,
            lines: [
              {
                seq: 1,
                stream: "worker",
                ts: new Date().toISOString(),
                content: "late",
                level: "info",
              },
            ],
          },
          { headers },
        ),
        await routes.yields.post({ claimToken, message: "Late." }, { headers }),
        await routes.completions.post(
          {
            claimToken,
            status: "succeeded",
            resultJson: null,
            errorJson: null,
          },
          { headers },
        ),
        await routes["session-upload-url"].post(
          { claimToken, sizeBytes: SESSION_BYTES },
          { headers },
        ),
        await routes["artifact-upload-url"].post(
          { claimToken, relativeStorePath: "late.md", sizeBytes: 1 },
          { headers },
        ),
      ].map((result) => result.error?.status ?? 200);

      expect(statuses).toEqual([404, 404, 404, 404, 404, 404]);
      expect(await leftovers(chat, runIds)).toEqual(NOTHING_LEFT);
    },
  );

  serialTest("racing a reply: removes everything either way", async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const chat = await created();
      await answer(chat.taskRunId, "First answer.");

      const [result, replied] = await Promise.all([
        remove(chat.conversationId),
        reply(parseUuidV7(chat.conversationId), "Follow-up?"),
      ]);

      expect(result.ok).toBe(true);
      expect([200, 404]).toContain(replied.status);
      expect(await runsOf(chat.taskId)).toHaveLength(0);
      expect(await leftovers(chat, [chat.taskRunId])).toEqual(NOTHING_LEFT);
      expect(await sweepsPerRun([chat.taskRunId])).toEqual([1]);
    }
  });

  serialTest("racing a claim: removes everything either way", async () => {
    const { projectId, headers } = h.requireSetup();
    for (let attempt = 0; attempt < 5; attempt++) {
      const chat = await created();

      const [result, claimed] = await Promise.all([
        remove(chat.conversationId),
        h.apiClient.api["task-runs"].claims.post(
          {
            projectId,
            workerId: `chat-race-${crypto.randomUUID()}`,
            batchSize: 50,
            leaseDurationSeconds: 30,
          },
          { headers },
        ),
      ]);

      expect(result.ok).toBe(true);
      expect(claimed.error).toBeNull();
      expect(await leftovers(chat, [chat.taskRunId])).toEqual(NOTHING_LEFT);
      expect(await sweepsPerRun([chat.taskRunId])).toEqual([1]);
      const claimToken = claimed.data?.find(
        (each) => each.task.id === chat.taskRunId,
      )?.claimToken;
      if (claimToken) {
        const heartbeat = await h.apiClient.api["task-runs"]({
          taskRunId: chat.taskRunId,
        }).heartbeat.put({ claimToken, leaseDurationSeconds: 30 }, { headers });
        expect(heartbeat.error?.status).toBe(404);
      }
    }
  });

  serialTest("racing a yield: removes everything either way", async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const chat = await created();
      const claimToken = await claim(chat.taskRunId);

      const [result, yielded] = await Promise.all([
        remove(chat.conversationId),
        h.apiClient.api["task-runs"]({ taskRunId: chat.taskRunId }).yields.post(
          { claimToken, message: "Answer." },
          { headers: h.requireSetup().headers },
        ),
      ]);

      expect(result.ok).toBe(true);
      expect([200, 404]).toContain(yielded.error?.status ?? 200);
      expect(await leftovers(chat, [chat.taskRunId])).toEqual(NOTHING_LEFT);
      expect(await sweepsPerRun([chat.taskRunId])).toEqual([1]);
    }
  });
});
