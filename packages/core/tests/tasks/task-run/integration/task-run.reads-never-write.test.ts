import { beforeAll, describe, expect } from "bun:test";
import { eq } from "drizzle-orm";
import { createApp } from "@scarn/api/app";
import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { createScarnTreaty } from "tests/treaty";
import { createAppContext } from "@/lib/di";
import { getDb } from "@/lib/db";
import { taskRuns } from "@/lib/db/schema";
import type { TimeProvider } from "@/lib/time-provider";
import type { ProjectContract } from "@/projects/project/contracts/project-contracts";
import { InMemoryObjectStore } from "@/artifacts/infra/in-memory-object-store";
import { serialTest, unwrapAsync, unwrapStartedTaskAsync } from "tests/utils";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import { seedWorkItem } from "tests/lib/db/seed-task-prerequisites";

const buildStepDefinitionPayload = (projectId: UuidV7, key: string) => ({
  projectId,
  key,
  name: "Readable step",
  description: "Reusable step for reads-never-write tests",
  prompt: "Return a result payload.",
  version: 1,
  kind: "user_defined" as const,
  inputSchemaJson: { type: "object" },
  resultSchemaJson: { type: "object" },
  status: "active" as const,
});

const readPersistedRow = async (
  taskRunId: UuidV7,
): Promise<{ status: string; completedAt: Date | null }> => {
  const [row] = await getDb()
    .select({
      status: taskRuns.status,
      completedAt: taskRuns.completedAt,
    })
    .from(taskRuns)
    .where(eq(taskRuns.id, taskRunId));
  if (!row) {
    throw new Error("Expected task row to exist");
  }
  return row;
};

/**
 * Phase 2 load-bearing invariant: reads NEVER write. Liveness (`abandoned` /
 * `timeout`) is derived on the entity's `status` getter, so a step whose lease
 * has lapsed reports `abandoned` through every read entry point WITHOUT
 * persisting that status or stamping `completed_at`. The persisted
 * `task_runs.status` column stays exactly as the last real write left it
 * (`running`) no matter how many times, or through which endpoint, it is read.
 */
describe("task reads never write", () => {
  let currentTime = new Date("2026-07-01T13:00:00.000Z");
  const timeProvider: TimeProvider = {
    now: () => currentTime,
    nowIso: () => currentTime.toISOString(),
  };
  const objectStore = new InMemoryObjectStore();
  const app = createApp(createAppContext({ timeProvider, objectStore }));
  const apiClient = createScarnTreaty(app);
  let project: ProjectContract | undefined;
  let authHeaders: { authorization: string } | undefined;
  let stepDefinitionId: UuidV7 | undefined;

  beforeAll(async () => {
    const owner = await createTestUserAndSession({
      email: `reads-never-write-${crypto.randomUUID()}@example.com`,
    });
    authHeaders = owner.authHeaders;
    project = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: "Reads Never Write Project",
          description: "Project for reads-never-write tests",
          gitUrl: "https://github.com/example/test-project.git",
        },
        { headers: { ...owner.authHeaders } },
      ),
    );
    const stepDefinition = await unwrapAsync(
      apiClient.api["step-definitions"].post(
        buildStepDefinitionPayload(
          parseUuidV7(project.id),
          `reads_never_write_step_${crypto.randomUUID()}`,
        ),
        { headers: { ...owner.authHeaders } },
      ),
    );
    stepDefinitionId = stepDefinition.id;
  });

  serialTest(
    "reading a lease-expired step through every entry point leaves the persisted status untouched",
    async () => {
      if (!project || !authHeaders || !stepDefinitionId) {
        throw new Error("Expected setup to complete");
      }
      const projectId = parseUuidV7(project.id);
      const headers = { ...authHeaders };

      // Claim a step, then advance past its 30s lease so every subsequent read
      // derives `abandoned`.
      currentTime = new Date("2026-07-01T13:00:00.000Z");
      const { run: created } = await unwrapStartedTaskAsync(
        apiClient.api.tasks.post(
          {
            projectId,
            workItemId: await seedWorkItem(projectId),
            stepDefinitionId,
            stepDefinitionVersion: 1,
            inputJson: { ticketId: "reads-never-write" },
            executionTimeoutSeconds: 300,
          },
          { headers },
        ),
      );
      const taskRunId = created.id;
      const claims = await unwrapAsync(
        apiClient.api["task-runs"].claims.post(
          {
            projectId,
            workerId: "worker-r",
            batchSize: 1,
            leaseDurationSeconds: 30,
          },
          { headers },
        ),
      );
      const claimToken = claims[0]?.claimToken;
      if (!claimToken) {
        throw new Error("Expected claim token");
      }

      currentTime = new Date("2026-07-01T13:00:31.000Z");

      // Precondition: the raw column is still `running` and `completed_at` null.
      const before = await readPersistedRow(taskRunId);
      expect(before.status).toBe("running");
      expect(before.completedAt).toBeNull();

      // 1. Single-row display read.
      const single = await unwrapAsync(
        apiClient.api["task-runs"]({ taskRunId: taskRunId }).get({ headers }),
      );
      expect(single.status).toBe("abandoned");

      // 2. Project-wide list read.
      const list = await unwrapAsync(
        apiClient.api["task-runs"].get({
          query: { projectId },
          headers,
        }),
      );
      expect(list.find((step) => step.id === taskRunId)?.status).toBe(
        "abandoned",
      );

      // 3. Log feed read.
      const logs = await unwrapAsync(
        apiClient.api["task-runs"]({ taskRunId: taskRunId }).logs.get({
          query: { from: 0, limit: 100 },
          headers,
        }),
      );
      expect(logs).toBeDefined();

      // 4. Log archive read (404 without an archive, but still loads the step).
      const archive = await apiClient.api["task-runs"]({
        taskRunId: taskRunId,
      }).logs.archive.get({ headers });
      expect(archive.error?.status).toBe(404);

      // 5. Artifact list read.
      const artifacts = await unwrapAsync(
        apiClient.api["task-runs"]({ taskRunId: taskRunId }).artifacts.get({
          headers,
        }),
      );
      expect(artifacts).toEqual([]);

      // Every read above derived `abandoned` but must NOT have persisted it: the
      // raw column is untouched and `completed_at` is still null.
      const after = await readPersistedRow(taskRunId);
      expect(after.status).toBe("running");
      expect(after.completedAt).toBeNull();
    },
  );
});
