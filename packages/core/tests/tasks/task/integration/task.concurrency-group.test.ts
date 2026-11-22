import { describe, expect } from "bun:test";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { workItems } from "@/lib/db/schema";
import { concurrentTest, unwrapAsync } from "tests/utils";
import {
  childCreate,
  createRunnerHarness,
  projectAutomation,
  uniqueKey,
  workItemAutomation,
} from "tests/pipeline-definitions/automation/integration/automation-runner-test-support";
import { recordingWorkNotifier } from "tests/tasks/task-run/recording-work-notifier";
import { createConcurrencyGroupHarness } from "./concurrency-group-test-support";

/**
 * A step's `concurrency: { max, waiting }` limits its live Tasks on one work
 * item: `max` hold a place, `waiting` more wait for one with no run, and a
 * Task past both is dropped and never created. A Task that ends admits the
 * oldest waiting one.
 */
describe("Task concurrency groups", () => {
  const {
    createStep,
    seedItem,
    postTask,
    startTask,
    cancel,
    succeedRun,
    block,
    stateOf,
    tasksOn,
  } = createConcurrencyGroupHarness("task-concurrency");

  const runIdOf = (started: { run: { id: string } | null }) => {
    if (!started.run) {
      throw new Error("Expected the Task to start with a run");
    }
    return started.run.id;
  };

  const itemExists = async (id: string) =>
    (await getDb().select().from(workItems).where(eq(workItems.id, id)))
      .length === 1;

  concurrentTest(
    "{ max: 1, waiting: 1 }: one runs, one waits, a third is dropped, and the waiting one runs when the first ends",
    async () => {
      const step = await createStep({ max: 1, waiting: 1 });
      const workItemId = await seedItem();

      const first = await startTask(workItemId, step);
      const second = await startTask(workItemId, step);
      const third = await postTask(workItemId, step);

      expect(first.task.status).toBe("queued");
      expect(second.task.status).toBe("waiting_for_concurrency_slot");
      expect(second.run).toBeNull();
      expect(third.status).toBe(409);
      expect(third.error?.value).toMatchObject({
        code: "Scarn.ConcurrencyGroupFull",
        meta: { stepKey: step.key, heldBy: [first.task.id] },
      });
      expect(await tasksOn(workItemId)).toHaveLength(2);

      await succeedRun(workItemId, runIdOf(first));

      expect(await stateOf(second.task.id)).toEqual({
        status: "queued",
        runs: [{ number: 1, reason: "initial", status: "queued" }],
      });
    },
  );

  concurrentTest("{ max: 1, waiting: 0 } drops the second Task", async () => {
    const step = await createStep({ max: 1, waiting: 0 });
    const workItemId = await seedItem();
    const first = await startTask(workItemId, step);

    const second = await postTask(workItemId, step);

    expect(second.status).toBe(409);
    expect(second.error?.value).toMatchObject({
      meta: { heldBy: [first.task.id] },
    });
    expect((await tasksOn(workItemId)).map((task) => task.id)).toEqual([
      first.task.id,
    ]);
  });

  concurrentTest("a step without a limit skips the group", async () => {
    const step = await createStep(null);
    const workItemId = await seedItem();

    const started = await Promise.all(
      [1, 2, 3].map(async () => await startTask(workItemId, step)),
    );

    expect(started.map(({ task }) => task.status)).toEqual([
      "queued",
      "queued",
      "queued",
    ]);
  });

  concurrentTest("arrivals in parallel transactions take turns", async () => {
    const step = await createStep({ max: 1, waiting: 1 });
    const workItemId = await seedItem();

    const responses = await Promise.all(
      [1, 2, 3, 4].map(async () => await postTask(workItemId, step)),
    );

    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 200, 409, 409,
    ]);
    expect(
      (await tasksOn(workItemId)).map((task) => task.status).sort(),
    ).toEqual(["queued", "waiting_for_concurrency_slot"]);
  });

  concurrentTest(
    "a Task admitted on a blocked item waits for work",
    async () => {
      const step = await createStep({ max: 1, waiting: 1 });
      const workItemId = await seedItem();
      const first = await startTask(workItemId, step);
      const second = await startTask(workItemId, step);
      await block(workItemId, await seedItem());

      await cancel(first.task.id);

      expect(await stateOf(second.task.id)).toEqual({
        status: "waiting_for_work",
        runs: [],
      });
    },
  );

  concurrentTest(
    "cancelling a waiting Task frees its place in the queue",
    async () => {
      const step = await createStep({ max: 1, waiting: 1 });
      const workItemId = await seedItem();
      const first = await startTask(workItemId, step);
      const second = await startTask(workItemId, step);

      await cancel(second.task.id);
      const third = await startTask(workItemId, step);

      expect((await stateOf(second.task.id)).status).toBe("cancelled");
      expect(third.task.status).toBe("waiting_for_concurrency_slot");
      expect((await stateOf(first.task.id)).status).toBe("queued");
    },
  );

  concurrentTest(
    "a new version of the step pushed mid-run shares the group",
    async () => {
      const v1 = await createStep({ max: 1, waiting: 0 });
      const workItemId = await seedItem();
      const first = await startTask(workItemId, v1);
      const v2 = await createStep(
        { max: 1, waiting: 0 },
        { key: v1.key, version: 2 },
      );

      const second = await postTask(workItemId, v2);

      expect(second.status).toBe(409);
      expect(second.error?.value).toMatchObject({
        meta: { heldBy: [first.task.id] },
      });
    },
  );

  concurrentTest(
    "the step's latest version sets the limit a promotion fills",
    async () => {
      const v1 = await createStep({ max: 1, waiting: 2 });
      const workItemId = await seedItem();
      const first = await startTask(workItemId, v1);
      const second = await startTask(workItemId, v1);
      const third = await startTask(workItemId, v1);
      await createStep({ max: 2, waiting: 2 }, { key: v1.key, version: 2 });

      await succeedRun(workItemId, runIdOf(first));

      expect((await stateOf(second.task.id)).status).toBe("queued");
      expect((await stateOf(third.task.id)).status).toBe("queued");
    },
  );

  concurrentTest(
    "an automation starting into a held group starts nothing",
    async () => {
      const h = await createRunnerHarness("task-concurrency-automation");
      const step = await h.createStep("limited", {
        concurrency: { max: 1, waiting: 0 },
      });
      const key = uniqueKey("triage");
      await h.publish(
        projectAutomation(key, [
          {
            event: "workItem.label.added",
            next: { routes: [{ kind: "step", to: step.key, on: "workItem" }] },
          },
        ]),
      );
      await h.enable(key);
      const workItemId = await h.createItem();
      const holding = await unwrapAsync(
        h.apiClient.api.tasks.post(
          {
            projectId: h.projectId,
            workItemId,
            stepDefinitionId: step.id,
            stepDefinitionVersion: step.version,
            inputJson: null,
          },
          { headers: h.headers },
        ),
      );

      await h.addLabels(workItemId, ["triage"]);

      expect((await h.tasksOn(workItemId)).map((task) => task.id)).toEqual([
        holding.task.id,
      ]);
      expect(await h.activityOf(workItemId)).toEqual([
        `Automation ${key} · workItem.label.added · rule 1: skipped: concurrency group full`,
      ]);
    },
  );

  concurrentTest(
    "an automation fired by an agent's run waits in a held group, and the run's changes still apply",
    async () => {
      const h = await createRunnerHarness("task-concurrency-agent-run");
      const limited = await h.createStep("limited", {
        concurrency: { max: 1, waiting: 1 },
      });
      const key = uniqueKey("on-child");
      await h.publish(
        workItemAutomation(key, [
          {
            event: "child.created",
            next: {
              routes: [{ kind: "step", to: limited.key, on: "workItem" }],
            },
          },
        ]),
      );
      const parent = await h.createItem("Parent");
      await h.attach(parent, key);
      const holding = await unwrapAsync(
        h.apiClient.api.tasks.post(
          {
            projectId: h.projectId,
            workItemId: parent,
            stepDefinitionId: limited.id,
            stepDefinitionVersion: limited.version,
            inputJson: null,
          },
          { headers: h.headers },
        ),
      );
      const child = childCreate("Child");

      await h.runCreatingChildren(parent, [child]);

      const tasks = await h.tasksOn(parent);
      expect(tasks.map((task) => task.id)).toHaveLength(2);
      expect(tasks[0]?.id).toBe(holding.task.id);
      expect(tasks[1]?.status).toBe("waiting_for_concurrency_slot");
      expect(await itemExists(child.workItemId)).toBe(true);
    },
  );
});

describe("Task concurrency groups: work notifications", () => {
  const { workNotifier, enqueued } = recordingWorkNotifier();
  const { createStep, seedItem, startTask, succeedRun, requireSetup } =
    createConcurrencyGroupHarness("task-concurrency-notify", { workNotifier });

  concurrentTest(
    "a waiting Task admitted when the holder ends notifies its project",
    async () => {
      const step = await createStep({ max: 1, waiting: 1 });
      const workItemId = await seedItem();
      const first = await startTask(workItemId, step);
      await startTask(workItemId, step);
      const before = enqueued.length;

      await succeedRun(workItemId, first.run?.id ?? "");

      expect(enqueued.slice(before)).toEqual([requireSetup().projectId]);
    },
  );
});
