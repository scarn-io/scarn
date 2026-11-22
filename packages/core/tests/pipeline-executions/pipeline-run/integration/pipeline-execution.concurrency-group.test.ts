import { beforeAll, describe, expect } from "bun:test";
import { eq } from "drizzle-orm";
import type { PipelineDocument } from "@scarn/sdk/contracts/pipeline-document";
import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { getDb } from "@/lib/db";
import { nodeVisits, tasks } from "@/lib/db/schema";
import { serialTest, unwrapAsync } from "tests/utils";
import {
  buildAgentStepDefinitionPayload,
  createPipelineFromDocument,
} from "tests/pipeline-definitions/pipeline-test-support";
import { createTestWorkItem } from "tests/tasks/task-run/integration/task-run-test-support";
import { createPipelineRunHarness } from "./pipeline-run-test-support";

/**
 * A pipeline step visit's Task arrives at its step's concurrency group like
 * any other: with no place but room to wait it waits with no run, and a full
 * group fails the visit with `Scarn.ConcurrencyGroupFull`, which `catch`
 * can take.
 */
describe("pipeline step visits in a concurrency group", () => {
  const harness = createPipelineRunHarness("pipeline-concurrency");

  beforeAll(async () => {
    await harness.setUp();
  });

  const createLimitedStep = async (concurrency: {
    max: number;
    waiting: number;
  }) => {
    const { projectId, headers } = harness.requireSetup();
    const created = await unwrapAsync(
      harness.apiClient.api["step-definitions"].post(
        { ...buildAgentStepDefinitionPayload(projectId), concurrency },
        { headers },
      ),
    );
    return {
      id: parseUuidV7(created.id),
      version: created.version,
      key: created.key,
    };
  };

  /** A work item whose `step` group is held by a standalone Task. */
  const heldItem = async (step: { id: UuidV7; version: number }) => {
    const { projectId, headers } = harness.requireSetup();
    const workItem = await createTestWorkItem(
      harness.apiClient,
      headers,
      projectId,
      "concurrency",
    );
    const workItemId = parseUuidV7(workItem.id);
    const holder = await unwrapAsync(
      harness.apiClient.api.tasks.post(
        {
          projectId,
          workItemId,
          stepDefinitionId: step.id,
          stepDefinitionVersion: step.version,
          inputJson: null,
        },
        { headers },
      ),
    );
    return { workItemId, holder };
  };

  const startRunOn = async (workItemId: UuidV7, document: PipelineDocument) => {
    const { projectId, headers } = harness.requireSetup();
    const definition = await createPipelineFromDocument(
      harness.apiClient,
      headers,
      projectId,
      document,
    );
    const execution = await unwrapAsync(
      harness.apiClient.api["pipeline-executions"].post(
        {
          projectId,
          workItemId,
          pipelineDefinitionId: parseUuidV7(definition.id),
        },
        { headers },
      ),
    );
    return execution.id;
  };

  const limitedThenRecover = (
    limitedKey: string,
    withCatch: boolean,
  ): PipelineDocument => ({
    schemaVersion: 1,
    key: harness.uniqueKey("concurrency"),
    start: { to: "limited" },
    nodes: {
      limited: {
        kind: "step",
        step: limitedKey,
        ...(withCatch
          ? {
              catch: [
                {
                  on: ["Scarn.ConcurrencyGroupFull"],
                  to: "recover",
                  args: { reason: "error.message" },
                },
              ],
            }
          : {}),
        next: { routes: [{ to: "done" }] },
      },
      ...(withCatch
        ? {
            recover: {
              kind: "step" as const,
              step: harness.requireSetup().stepKey,
              next: { routes: [{ to: "done" }] },
            },
          }
        : {}),
      done: { kind: "succeed" },
    },
  });

  const visitTaskOf = async (visitId: string) => {
    const [visit] = await getDb()
      .select({ taskId: nodeVisits.taskId })
      .from(nodeVisits)
      .where(eq(nodeVisits.id, visitId));
    return visit?.taskId ?? null;
  };

  serialTest(
    "a full group fails the visit, and catch takes the error",
    async () => {
      const step = await createLimitedStep({ max: 1, waiting: 0 });
      const { workItemId, holder } = await heldItem(step);

      const executionId = await startRunOn(
        workItemId,
        limitedThenRecover(step.key, true),
      );

      const run = await harness.getRun(executionId);
      const limited = harness.visitOf(run, "limited");
      expect(limited).toMatchObject({
        status: "failed",
        error: {
          name: "Scarn.ConcurrencyGroupFull",
          cause: { heldBy: [holder.task.id] },
        },
        tasks: [],
      });
      expect(await visitTaskOf(limited.id)).toBeNull();
      expect(harness.visitOf(run, "recover")).toMatchObject({
        status: "active",
        transition: { kind: "catch", index: 0 },
      });
      expect(run.runStatus).toBe("active");
    },
  );

  serialTest("a full group with no catch fails the run", async () => {
    const step = await createLimitedStep({ max: 1, waiting: 0 });
    const { workItemId } = await heldItem(step);

    const executionId = await startRunOn(
      workItemId,
      limitedThenRecover(step.key, false),
    );

    expect(await harness.getRun(executionId)).toMatchObject({
      runStatus: "failed",
      error: { name: "Scarn.ConcurrencyGroupFull" },
    });
  });

  serialTest(
    "a visit waits for a place, and runs once the holder ends",
    async () => {
      const step = await createLimitedStep({ max: 1, waiting: 1 });
      const { workItemId, holder } = await heldItem(step);

      const executionId = await startRunOn(
        workItemId,
        limitedThenRecover(step.key, false),
      );

      const waiting = harness.visitOf(
        await harness.getRun(executionId),
        "limited",
      );
      expect(waiting).toMatchObject({ status: "active", tasks: [] });
      const taskId = await visitTaskOf(waiting.id);
      if (!taskId) {
        throw new Error("Expected the visit's waiting Task");
      }
      const [task] = await getDb()
        .select({ status: tasks.status })
        .from(tasks)
        .where(eq(tasks.id, taskId));
      expect(task?.status).toBe("waiting_for_concurrency_slot");

      const holding = await harness.claimOne(workItemId);
      expect<string>(holding.taskId).toBe(holder.run?.id ?? "");
      await harness.complete(holding, "succeeded");

      const promoted = await harness.claimOne(workItemId);
      await harness.complete(promoted, "succeeded");

      const finished = await harness.getRun(executionId);
      expect(harness.visitOf(finished, "limited")).toMatchObject({
        status: "succeeded",
        resultTaskId: promoted.taskId,
      });
      expect(finished.runStatus).toBe("succeeded");
    },
  );

  serialTest(
    "a visit that waited starts from its upstream work branch",
    async () => {
      const step = await createLimitedStep({ max: 1, waiting: 1 });
      const { workItemId, holder } = await heldItem(step);
      const executionId = await startRunOn(workItemId, {
        schemaVersion: 1,
        key: harness.uniqueKey("concurrency-branch"),
        start: { to: "first" },
        nodes: {
          first: {
            kind: "step",
            step: harness.requireSetup().stepKey,
            next: { routes: [{ to: "limited" }] },
          },
          limited: {
            kind: "step",
            step: step.key,
            next: { routes: [{ to: "done" }] },
          },
          done: { kind: "succeed" },
        },
      });

      const claims = await harness.claim(workItemId, { batchSize: 2 });
      const holding = claims.find((each) => each.taskId === holder.run?.id);
      const first = claims.find((each) => each.taskId !== holder.run?.id);
      if (!holding || !first) {
        throw new Error("Expected the holder's run and the first visit's run");
      }
      await unwrapAsync(
        harness.apiClient.api["task-runs"]({
          taskRunId: first.taskId,
        }).completions.post(
          {
            claimToken: first.claimToken,
            status: "succeeded",
            resultJson: { status: "completed" },
            errorJson: null,
            workBranch: "scarn/first-1",
          },
          { headers: harness.requireSetup().headers },
        ),
      );
      const waiting = harness.visitOf(
        await harness.getRun(executionId),
        "limited",
      );
      expect(waiting).toMatchObject({ status: "active", tasks: [] });

      await harness.complete(holding, "succeeded");

      const promoted = await harness.claimOne(workItemId);
      const promotedRun = await harness.getTaskRun(
        parseUuidV7(promoted.taskId),
      );
      expect(promotedRun).toMatchObject({
        number: 1,
        reason: "initial",
        baseBranch: "scarn/first-1",
      });
    },
  );
});
