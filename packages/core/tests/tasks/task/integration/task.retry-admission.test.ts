import { describe, expect } from "bun:test";
import { concurrentTest, unwrapAsync } from "tests/utils";
import { createConcurrencyGroupHarness } from "./concurrency-group-test-support";

describe("manual retry admission", () => {
  const h = createConcurrencyGroupHarness("retry-admission");
  const read = async (taskId: string) => {
    const { headers } = h.requireSetup();
    const endpoint = h.apiClient.api.tasks({ taskId });
    return {
      task: await unwrapAsync(endpoint.get({ headers })),
      runs: await unwrapAsync(endpoint.runs.get({ headers })),
    };
  };

  concurrentTest(
    "cancelled without runs stays blocked until its blocker closes",
    async () => {
      const step = await h.createStep({ max: 1, waiting: 0 });
      const workItemId = await h.seedItem();
      const blocker = await h.seedItem();
      await h.block(workItemId, blocker);
      const created = await h.startTask(workItemId, step);
      expect(created.run).toBeNull();
      await h.cancel(created.task.id);
      const { headers } = h.requireSetup();
      const retried = await unwrapAsync(
        h.apiClient.api
          .tasks({ taskId: created.task.id })
          .retry.post({ expectedLatestRunId: null }, { headers }),
      );
      expect(retried).toEqual({ taskId: created.task.id, taskRunId: null });
      expect(await read(created.task.id)).toMatchObject({
        task: { status: "waiting_for_work" },
        runs: [],
      });
      const dropped = await h.postTask(workItemId, step);
      expect(dropped.error?.status).toBe(409);
      await unwrapAsync(
        h.apiClient.api["work-items"]({ workItemId: blocker }).state.put(
          { state: "closed", reason: "completed" },
          { headers },
        ),
      );
      expect(await read(created.task.id)).toMatchObject({
        task: { status: "queued" },
        runs: [{ number: 1, reason: "initial", status: "queued" }],
      });
    },
  );

  concurrentTest(
    "cancelled without runs queues its initial run when blockers have cleared",
    async () => {
      const step = await h.createStep(null);
      const workItemId = await h.seedItem();
      const blocker = await h.seedItem();
      await h.block(workItemId, blocker);
      const created = await h.startTask(workItemId, step);
      await h.cancel(created.task.id);
      const { headers } = h.requireSetup();
      await unwrapAsync(
        h.apiClient.api["work-items"]({ workItemId: blocker }).state.put(
          { state: "closed", reason: "completed" },
          { headers },
        ),
      );
      expect((await read(created.task.id)).runs).toEqual([]);
      const retried = await unwrapAsync(
        h.apiClient.api
          .tasks({ taskId: created.task.id })
          .retry.post({ expectedLatestRunId: null }, { headers }),
      );
      expect(retried.taskRunId).not.toBeNull();
      expect(await read(created.task.id)).toMatchObject({
        task: { status: "queued" },
        runs: [{ id: retried.taskRunId, number: 1, reason: "initial" }],
      });
    },
  );

  concurrentTest(
    "a full group rolls back retry, then reacquires the released slot",
    async () => {
      const step = await h.createStep({ max: 1, waiting: 1 });
      const workItemId = await h.seedItem();
      const first = await h.startTask(workItemId, step);
      if (!first.run) throw new Error("Expected initial run");
      const waiting = await h.startTask(workItemId, step);
      expect(waiting.task.status).toBe("waiting_for_concurrency_slot");
      await h.cancel(first.task.id);
      expect((await read(waiting.task.id)).task.status).toBe("queued");
      const before = await read(first.task.id);
      const waitingBefore = await read(waiting.task.id);
      const { headers } = h.requireSetup();
      const endpoint = h.apiClient.api.tasks({ taskId: first.task.id }).retry;
      const refused = await endpoint.post(
        { expectedLatestRunId: first.run.id },
        { headers },
      );
      expect(refused.error?.status).toBe(409);
      expect(refused.error?.value).toMatchObject({
        code: "Scarn.ConcurrencyGroupFull",
        meta: { stepKey: step.key, heldBy: [waiting.task.id] },
      });
      expect(await read(first.task.id)).toEqual(before);
      expect(await read(waiting.task.id)).toEqual(waitingBefore);
      await h.cancel(waiting.task.id);
      const retried = await unwrapAsync(
        endpoint.post({ expectedLatestRunId: first.run.id }, { headers }),
      );
      expect(await read(first.task.id)).toMatchObject({
        task: { status: "queued" },
        runs: [
          { status: "cancelled" },
          { id: retried.taskRunId, reason: "retry", status: "queued" },
        ],
      });
      const next = await h.startTask(workItemId, step);
      expect(next.task.status).toBe("waiting_for_concurrency_slot");
      if (!retried.taskRunId) throw new Error("Expected retry run");
      await h.succeedRun(workItemId, retried.taskRunId);
      expect((await read(next.task.id)).task.status).toBe("queued");
    },
  );
});
