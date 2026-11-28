import { beforeAll, describe, expect } from "bun:test";
import { eq } from "drizzle-orm";
import { parseUuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { getDb } from "@/lib/db";
import { nodeVisits, taskGrantRequests, tasks } from "@/lib/db/schema";
import { serialTest, unwrapAsync } from "tests/utils";
import {
  buildAgentStepDefinitionPayload,
  createPipelineFromDocument,
} from "tests/pipeline-definitions/pipeline-test-support";
import { createWorkItem } from "tests/pipeline-definitions/automation/integration/automation-test-support";
import { createTestWorkItem } from "tests/tasks/task-run/integration/task-run-test-support";
import { createPipelineRunHarness } from "./pipeline-run-test-support";

/**
 * A pipeline step visit's Task may ask a person for more grants only when
 * its step declares `grantRequests`, whatever its work item's platform.
 */
describe("pipeline step visits and grant requests", () => {
  const harness = createPipelineRunHarness("pipeline-grant-requests");

  beforeAll(async () => {
    await harness.setUp();
  });

  /** Starts a run whose `ask` step visit's Task may ask for grants. */
  const startRun = async (
    grantRequests: boolean,
    platform: "scarn" | "github",
  ) => {
    const { projectId, headers } = harness.requireSetup();
    const step = await unwrapAsync(
      harness.apiClient.api["step-definitions"].post(
        { ...buildAgentStepDefinitionPayload(projectId), grantRequests },
        { headers },
      ),
    );
    const workItem =
      platform === "scarn"
        ? await createWorkItem(
            { apiClient: harness.apiClient, projectId },
            headers,
          )
        : await createTestWorkItem(
            harness.apiClient,
            headers,
            projectId,
            "grant-requests",
          );
    const definition = await createPipelineFromDocument(
      harness.apiClient,
      headers,
      projectId,
      {
        schemaVersion: 1,
        key: harness.uniqueKey("grant-requests"),
        start: { to: "ask" },
        nodes: {
          ask: {
            kind: "step",
            step: step.key,
            next: { routes: [{ to: "done" }] },
          },
          done: { kind: "succeed" },
        },
      },
    );
    const execution = await unwrapAsync(
      harness.apiClient.api["pipeline-executions"].post(
        {
          projectId,
          workItemId: parseUuidV7(workItem.id),
          pipelineDefinitionId: parseUuidV7(definition.id),
        },
        { headers },
      ),
    );
    return { executionId: execution.id, workItemId: workItem.id };
  };

  const visitTaskGrantRequests = async (
    grantRequests: boolean,
    platform: "scarn" | "github",
  ) => {
    const { executionId } = await startRun(grantRequests, platform);
    const visit = harness.visitOf(await harness.getRun(executionId), "ask");
    const [row] = await getDb()
      .select({ grantRequests: tasks.grantRequests })
      .from(nodeVisits)
      .innerJoin(tasks, eq(tasks.id, nodeVisits.taskId))
      .where(eq(nodeVisits.id, visit.id));
    return row?.grantRequests;
  };

  serialTest(
    "a person's run on a native item lets the Task ask when its step declares grantRequests",
    async () => {
      expect(await visitTaskGrantRequests(true, "scarn")).toBe(true);
    },
  );

  serialTest("a step without grantRequests gives no flag", async () => {
    expect(await visitTaskGrantRequests(false, "scarn")).toBe(false);
  });

  serialTest(
    "a synced work item lets the Task ask too; changes to it are refused when they apply",
    async () => {
      expect(await visitTaskGrantRequests(true, "github")).toBe(true);
    },
  );

  serialTest(
    "deciding a visit Task's request resumes the run like a reply",
    async () => {
      const { headers } = harness.requireSetup();
      const { executionId, workItemId } = await startRun(true, "scarn");
      const claimed = await harness.claimOne(workItemId);
      await unwrapAsync(
        harness.apiClient.api["task-runs"]({
          taskRunId: claimed.taskId,
        }).yields.post(
          {
            claimToken: claimed.claimToken,
            message: "May I close it?",
            grantRequest: {
              reason: "Closing finishes the job",
              grants: [
                { resource: "workItem", action: "close", scope: "self" },
              ],
            },
          },
          { headers },
        ),
      );
      const waiting = harness.visitOf(await harness.getRun(executionId), "ask");
      expect(waiting.status).toBe("waiting");
      const [request] = await getDb()
        .select()
        .from(taskGrantRequests)
        .where(eq(taskGrantRequests.taskRunId, claimed.taskId));
      if (!request) {
        throw new Error("Expected a pending grant request");
      }

      await unwrapAsync(
        harness.apiClient.api["task-grant-requests"]({
          grantRequestId: parseUuidV7(request.id),
        }).decision.post(
          {
            approved: [
              { resource: "workItem", action: "close", scope: "self" },
            ],
          },
          { headers },
        ),
      );

      const run = await harness.getRun(executionId);
      expect(run.runStatus).toBe("active");
      const visit = harness.visitOf(run, "ask");
      expect(visit.status).not.toBe("waiting");
      expect(
        visit.tasks.filter((task) => task.status === "queued"),
      ).toHaveLength(1);
    },
    30_000,
  );
});
