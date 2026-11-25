import { beforeAll, describe, expect } from "bun:test";
import { createApp } from "@scarn/api/app";
import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { createScarnTreaty } from "tests/treaty";
import { eq } from "drizzle-orm";
import { createAppContext } from "@/lib/di";
import { getDb } from "@/lib/db";
import { taskRuns, tasks } from "@/lib/db/schema";
import type { TimeProvider } from "@/lib/time-provider";
import type { ProjectContract } from "@/projects/project/contracts/project-contracts";
import { InMemoryObjectStore } from "@/artifacts/infra/in-memory-object-store";
import { taskLogArchiveKey } from "@/tasks/task-log/application/finalize-task-log";
import { serialTest, unwrapAsync, unwrapStartedTaskAsync } from "tests/utils";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import { seedWorkItem } from "tests/lib/db/seed-task-prerequisites";

const buildStepDefinitionPayload = (projectId: UuidV7, key: string) => ({
  projectId,
  key,
  name: "Loggable step",
  description: "Reusable step for log streaming tests",
  prompt: "Return a result payload.",
  version: 1,
  kind: "user_defined" as const,
  inputSchemaJson: { type: "object" },
  resultSchemaJson: { type: "object" },
  status: "active" as const,
});

const claimStep = async (
  apiClient: ReturnType<typeof createScarnTreaty>,
  authHeaders: { authorization: string },
  projectId: UuidV7,
  stepDefinitionId: UuidV7,
  workerId: string,
): Promise<{ taskRunId: UuidV7; claimToken: string }> => {
  const { run: task } = await unwrapStartedTaskAsync(
    apiClient.api.tasks.post(
      {
        projectId,
        workItemId: await seedWorkItem(projectId),
        stepDefinitionId,
        stepDefinitionVersion: 1,
        inputJson: { ticketId: `ticket-${workerId}` },
        executionTimeoutSeconds: 300,
      },
      { headers: { ...authHeaders } },
    ),
  );
  const claims = await unwrapAsync(
    apiClient.api["task-runs"].claims.post(
      {
        projectId,
        workerId,
        batchSize: 1,
        leaseDurationSeconds: 30,
      },
      { headers: { ...authHeaders } },
    ),
  );
  const claimToken = claims[0]?.claimToken;
  if (!claimToken) {
    throw new Error("Expected claim token to be returned");
  }
  return { taskRunId: task.id, claimToken };
};

describe("task logs", () => {
  let currentTime = new Date("2026-05-01T12:00:00.000Z");
  const timeProvider: TimeProvider = {
    now: () => currentTime,
    nowIso: () => currentTime.toISOString(),
  };
  // Inject an in-memory object store so the durable archive flow runs without
  // a real S3/RustFS backend, while still exercising the full feed -> archive
  // path through the live Elysia app + Postgres.
  const objectStore = new InMemoryObjectStore();
  const app = createApp(createAppContext({ timeProvider, objectStore }));
  const apiClient = createScarnTreaty(app);
  let project: ProjectContract | undefined;
  let authHeaders: { authorization: string } | undefined;
  let stepDefinitionId: UuidV7 | undefined;

  beforeAll(async () => {
    const owner = await createTestUserAndSession({
      email: `task-logs-${crypto.randomUUID()}@example.com`,
    });
    authHeaders = owner.authHeaders;
    project = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: "Task Logs Project",
          description: "Project for task log streaming tests",
          gitUrl: "https://github.com/example/test-project.git",
        },
        { headers: { ...owner.authHeaders } },
      ),
    );
    const stepDefinition = await unwrapAsync(
      apiClient.api["step-definitions"].post(
        buildStepDefinitionPayload(
          parseUuidV7(project.id),
          `log_step_${crypto.randomUUID()}`,
        ),
        { headers: { ...owner.authHeaders } },
      ),
    );
    stepDefinitionId = stepDefinition.id;
  });

  serialTest(
    "appends log lines and reads them back via the offset cursor",
    async () => {
      if (!project || !authHeaders || !stepDefinitionId) {
        throw new Error("Expected setup to complete");
      }
      currentTime = new Date("2026-05-01T12:00:00.000Z");
      const { taskRunId, claimToken } = await claimStep(
        apiClient,
        authHeaders,
        parseUuidV7(project.id),
        stepDefinitionId,
        "worker-read",
      );

      const append = await unwrapAsync(
        apiClient.api["task-runs"]({ taskRunId: taskRunId }).logs.post(
          {
            claimToken,
            lines: [
              {
                seq: 1,
                stream: "worker",
                ts: "2026-05-01T12:00:01.000Z",
                content: "worker line one",
                level: "info",
              },
              {
                seq: 2,
                stream: "ai-server",
                ts: "2026-05-01T12:00:02.000Z",
                content: "agent line two",
                level: "error",
              },
            ],
          },
          { headers: { ...authHeaders } },
        ),
      );
      expect(append.nextOffset).toBe(2);

      // Read from the start: returns all lines, advances the cursor, not complete.
      const firstPage = await unwrapAsync(
        apiClient.api["task-runs"]({ taskRunId: taskRunId }).logs.get({
          query: { from: 0, limit: 1000 },
          headers: { ...authHeaders },
        }),
      );
      expect(firstPage.complete).toBe(false);
      expect(firstPage.nextOffset).toBe(2);
      expect(firstPage.lines.map((line) => line.content)).toEqual([
        "worker line one",
        "agent line two",
      ]);
      expect(firstPage.lines.map((line) => line.stream)).toEqual([
        "worker",
        "ai-server",
      ]);
      // The structured level round-trips through the feed.
      expect(firstPage.lines.map((line) => line.level)).toEqual([
        "info",
        "error",
      ]);

      // Reading past the cursor returns nothing new.
      const emptyPage = await unwrapAsync(
        apiClient.api["task-runs"]({ taskRunId: taskRunId }).logs.get({
          query: { from: 2, limit: 1000 },
          headers: { ...authHeaders },
        }),
      );
      expect(emptyPage.lines).toEqual([]);
      expect(emptyPage.nextOffset).toBe(2);
    },
  );

  serialTest("append is idempotent on (taskRunId, seq)", async () => {
    if (!project || !authHeaders || !stepDefinitionId) {
      throw new Error("Expected setup to complete");
    }
    currentTime = new Date("2026-05-01T12:10:00.000Z");
    const { taskRunId, claimToken } = await claimStep(
      apiClient,
      authHeaders,
      parseUuidV7(project.id),
      stepDefinitionId,
      "worker-idempotent",
    );

    const line = {
      seq: 1,
      stream: "worker" as const,
      ts: "2026-05-01T12:10:01.000Z",
      content: "only once",
      level: "info" as const,
    };
    await unwrapAsync(
      apiClient.api["task-runs"]({ taskRunId: taskRunId }).logs.post(
        { claimToken, lines: [line] },
        { headers: { ...authHeaders } },
      ),
    );
    // Retried batch with the same seq must not duplicate.
    await unwrapAsync(
      apiClient.api["task-runs"]({ taskRunId: taskRunId }).logs.post(
        { claimToken, lines: [{ ...line, content: "ignored duplicate" }] },
        { headers: { ...authHeaders } },
      ),
    );

    const page = await unwrapAsync(
      apiClient.api["task-runs"]({ taskRunId: taskRunId }).logs.get({
        query: { from: 0, limit: 1000 },
        headers: { ...authHeaders },
      }),
    );
    expect(page.lines).toHaveLength(1);
    expect(page.lines[0]?.content).toBe("only once");
  });

  serialTest(
    "rejects appends from a caller without the claim token",
    async () => {
      if (!project || !authHeaders || !stepDefinitionId) {
        throw new Error("Expected setup to complete");
      }
      currentTime = new Date("2026-05-01T12:20:00.000Z");
      const { taskRunId } = await claimStep(
        apiClient,
        authHeaders,
        parseUuidV7(project.id),
        stepDefinitionId,
        "worker-auth",
      );

      const response = await apiClient.api["task-runs"]({
        taskRunId: taskRunId,
      }).logs.post(
        {
          claimToken: "not-the-real-claim-token",
          lines: [
            {
              seq: 1,
              stream: "worker",
              ts: "2026-05-01T12:20:01.000Z",
              content: "should be rejected",
              level: "info",
            },
          ],
        },
        { headers: { ...authHeaders } },
      );
      expect(response.data).toBeNull();
      expect(response.error?.status).toBe(409);
      expect(response.error?.value).toMatchObject({
        code: "TASK_OWNERSHIP_CONFLICT",
      });
    },
  );

  serialTest(
    "flushes the feed to the durable archive on completion and reports complete",
    async () => {
      if (!project || !authHeaders || !stepDefinitionId) {
        throw new Error("Expected setup to complete");
      }
      currentTime = new Date("2026-05-01T12:30:00.000Z");
      const { taskRunId, claimToken } = await claimStep(
        apiClient,
        authHeaders,
        parseUuidV7(project.id),
        stepDefinitionId,
        "worker-archive",
      );

      await unwrapAsync(
        apiClient.api["task-runs"]({ taskRunId: taskRunId }).logs.post(
          {
            claimToken,
            lines: [
              {
                seq: 1,
                stream: "worker",
                ts: "2026-05-01T12:30:01.000Z",
                content: "starting step",
                level: "info",
              },
              {
                seq: 2,
                stream: "ai-server",
                ts: "2026-05-01T12:30:02.000Z",
                content: "agent did work",
                level: "info",
              },
            ],
          },
          { headers: { ...authHeaders } },
        ),
      );

      currentTime = new Date("2026-05-01T12:30:10.000Z");
      const completed = await unwrapAsync(
        apiClient.api["task-runs"]({ taskRunId: taskRunId }).completions.post(
          {
            claimToken,
            status: "succeeded",
            resultJson: { status: "completed" },
            errorJson: null,
          },
          { headers: { ...authHeaders } },
        ),
      );
      expect(completed.status).toBe("succeeded");

      // The durable archive object was written as NDJSON in seq order.
      const archiveKey = taskLogArchiveKey(taskRunId);
      const archived = await objectStore.getObject(archiveKey);
      expect(archived).not.toBeNull();
      const ndjson = new TextDecoder().decode(archived?.body);
      const parsed = ndjson
        .trim()
        .split("\n")
        .map((entry) => JSON.parse(entry) as { content: string; seq: number });
      expect(parsed.map((entry) => entry.content)).toEqual([
        "starting step",
        "agent did work",
      ]);

      // The live feed has been purged but the read endpoint now reports the
      // step as complete (terminal + archived), telling the UI to switch over.
      const afterComplete = await unwrapAsync(
        apiClient.api["task-runs"]({ taskRunId: taskRunId }).logs.get({
          query: { from: 0, limit: 1000 },
          headers: { ...authHeaders },
        }),
      );
      expect(afterComplete.complete).toBe(true);
      expect(afterComplete.lines).toEqual([]);

      // The archive endpoint exposes the recorded metadata.
      const archiveMeta = await unwrapAsync(
        apiClient.api["task-runs"]({ taskRunId: taskRunId }).logs.archive.get({
          headers: { ...authHeaders },
        }),
      );
      expect(archiveMeta.sizeBytes).toBeGreaterThan(0);
    },
  );

  describe("a code step with logs.archive on-failure", () => {
    let onFailureStepId: UuidV7 | undefined;

    beforeAll(async () => {
      if (!project || !authHeaders) {
        throw new Error("Expected setup to complete");
      }
      const step = await unwrapAsync(
        apiClient.api["step-definitions"].post(
          {
            ...buildStepDefinitionPayload(
              parseUuidV7(project.id),
              `log_on_failure_${crypto.randomUUID()}`,
            ),
            kind: "code",
            prompt: null,
            entrypointJson: { sourceFile: ".scarn/steps.ts" },
            logs: { archive: "on-failure" },
          },
          { headers: { ...authHeaders } },
        ),
      );
      expect(step.logs).toEqual({ archive: "on-failure" });
      onFailureStepId = step.id;
    });

    const runToEnd = async (
      workerId: string,
      status: "succeeded" | "failed",
      { startedByPerson }: { startedByPerson: boolean },
    ) => {
      if (!project || !authHeaders || !onFailureStepId) {
        throw new Error("Expected setup to complete");
      }
      const { taskRunId, claimToken } = await claimStep(
        apiClient,
        authHeaders,
        parseUuidV7(project.id),
        onFailureStepId,
        workerId,
      );
      if (!startedByPerson) {
        const [run] = await getDb()
          .select({ taskId: taskRuns.taskId })
          .from(taskRuns)
          .where(eq(taskRuns.id, taskRunId));
        await getDb()
          .update(tasks)
          .set({ startedByUserId: null })
          .where(eq(tasks.id, run?.taskId ?? taskRunId));
      }
      await unwrapAsync(
        apiClient.api["task-runs"]({ taskRunId }).logs.post(
          {
            claimToken,
            lines: [
              {
                seq: 1,
                stream: "worker",
                ts: currentTime.toISOString(),
                content: "synced 0 issues",
                level: "info",
              },
            ],
          },
          { headers: { ...authHeaders } },
        ),
      );
      await unwrapAsync(
        apiClient.api["task-runs"]({ taskRunId }).completions.post(
          {
            claimToken,
            status,
            resultJson: status === "succeeded" ? {} : null,
            errorJson:
              status === "failed"
                ? { name: "Scarn.StepFailed", message: "boom" }
                : null,
          },
          { headers: { ...authHeaders } },
        ),
      );
      const page = await unwrapAsync(
        apiClient.api["task-runs"]({ taskRunId }).logs.get({
          query: { from: 0, limit: 1000 },
          headers: { ...authHeaders },
        }),
      );
      return {
        archived: await objectStore.getObject(taskLogArchiveKey(taskRunId)),
        liveLines: page.lines,
      };
    };

    serialTest(
      "skips the log of a succeeded run no person started",
      async () => {
        currentTime = new Date("2026-05-01T12:40:00.000Z");
        const { archived, liveLines } = await runToEnd(
          "worker-skip",
          "succeeded",
          { startedByPerson: false },
        );
        expect(archived).toBeNull();
        expect(liveLines).toEqual([]);
      },
    );

    serialTest("keeps the log of a failed run", async () => {
      currentTime = new Date("2026-05-01T12:50:00.000Z");
      const { archived } = await runToEnd("worker-fail", "failed", {
        startedByPerson: false,
      });
      expect(archived).not.toBeNull();
    });

    serialTest(
      "keeps the log of a succeeded run a person started",
      async () => {
        currentTime = new Date("2026-05-01T13:00:00.000Z");
        const { archived } = await runToEnd("worker-manual", "succeeded", {
          startedByPerson: true,
        });
        expect(archived).not.toBeNull();
      },
    );
  });
});
