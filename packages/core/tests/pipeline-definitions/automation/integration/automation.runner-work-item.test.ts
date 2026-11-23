import { beforeAll, describe, expect } from "bun:test";
import { concurrentTest } from "tests/utils";
import {
  childCreate,
  createRunnerHarness,
  uniqueKey,
  workItemAutomation,
  type RunnerHarness,
  type Step,
} from "./automation-runner-test-support";

/**
 * Work-item automations run on their work item's `self.attached` and on
 * events about its child work items, in the transaction of the change that
 * raised the event. Each target logs one line on the work item's activity.
 */
describe("work-item automations", () => {
  let harness: RunnerHarness | undefined;
  let research: Step | undefined;
  let plan: Step | undefined;

  beforeAll(async () => {
    harness = await createRunnerHarness("work-item");
    research = await harness.createStep("research", {
      inputSchemaJson: {
        type: "object",
        properties: { question: { type: "string" } },
        required: ["question"],
        additionalProperties: false,
      },
    });
    plan = await harness.createStep("plan");
  });

  const requireSetup = () => {
    if (!harness || !research || !plan) {
      throw new Error("Expected setup to complete");
    }
    return { h: harness, research, plan };
  };

  /** A parent with `rules` attached as a fresh automation. */
  const parentWith = async (rules: readonly object[]) => {
    const { h } = requireSetup();
    const key = uniqueKey("auto");
    await h.publish(workItemAutomation(key, rules));
    const parent = await h.createItem("Parent");
    await h.attach(parent, key);
    return { key, parent };
  };

  const researchOnReadyChild = () => {
    const { research } = requireSetup();
    return {
      key: "child-ready",
      event: "child.ready",
      next: {
        routes: [
          {
            kind: "step",
            to: research.key,
            args: { question: "event.child.title" },
            on: "child",
          },
        ],
      },
    };
  };

  concurrentTest(
    "self.attached starts its step on the work item, once",
    async () => {
      const { h, plan } = requireSetup();
      const { key, parent } = await parentWith([
        {
          key: "self-attached",
          event: "self.attached",
          next: { routes: [{ kind: "step", to: plan.key, on: "workItem" }] },
        },
      ]);

      await h.attach(parent, key);

      expect((await h.tasksOn(parent)).map((task) => task.step)).toEqual([
        plan.key,
      ]);
      expect(await h.activityOf(parent)).toEqual([
        `Automation ${key} · self.attached · rule 1: started ${plan.key}`,
      ]);
    },
  );

  concurrentTest(
    "child.ready puts the Task on a child created ready, with args from the event",
    async () => {
      const { h, research } = requireSetup();
      const { key, parent } = await parentWith([researchOnReadyChild()]);
      const ready = childCreate("What is X?");
      const blocked = childCreate("What is Y?", {
        blockedBy: [ready.workItemId],
      });

      await h.runCreatingChildren(parent, [ready, blocked]);

      expect(await h.tasksOn(ready.workItemId)).toMatchObject([
        { step: research.key, inputJson: { question: "What is X?" } },
      ]);
      expect(await h.tasksOn(blocked.workItemId)).toEqual([]);
      expect(await h.tasksOn(parent)).toEqual([]);
      expect(await h.activityOf(parent)).toEqual([
        `Automation ${key} · child.ready · rule 1: started ${research.key}`,
      ]);
    },
  );

  concurrentTest(
    "child.ready fires when the last blocker closes and when a child reopens",
    async () => {
      const { h, research } = requireSetup();
      const { parent } = await parentWith([researchOnReadyChild()]);
      const first = childCreate("First blocker");
      const second = childCreate("Second blocker");
      const blocked = childCreate("Blocked", {
        blockedBy: [first.workItemId, second.workItemId],
      });
      await h.runCreatingChildren(parent, [first, second, blocked]);
      const steps = async () =>
        (await h.tasksOn(blocked.workItemId)).map((task) => task.step);

      await h.setState(first.workItemId, "closed");
      expect(await steps()).toEqual([]);

      await h.setState(second.workItemId, "closed");
      expect(await steps()).toEqual([research.key]);

      await h.setState(blocked.workItemId, "closed");
      await h.setState(blocked.workItemId, "open");
      expect(await steps()).toEqual([research.key, research.key]);
    },
  );

  concurrentTest(
    "every matching rule fires in order; within one, the first matching route or otherwise",
    async () => {
      const { h, research, plan } = requireSetup();
      const { key, parent } = await parentWith([
        {
          key: "research",
          event: "child.created",
          next: {
            routes: [
              {
                when: {
                  path: "event.child.labels",
                  op: "contains",
                  value: "kind:research",
                },
                kind: "step",
                to: research.key,
                args: { question: "event.child.title" },
                on: "child",
              },
              { kind: "step", to: plan.key, on: "child" },
            ],
          },
        },
        {
          key: "child-created",
          event: "child.created",
          next: {
            routes: [
              {
                when: {
                  path: "event.child.labels",
                  op: "contains",
                  value: "kind:never",
                },
                kind: "step",
                to: plan.key,
                on: "workItem",
              },
            ],
            otherwise: { kind: "skip" },
          },
        },
        {
          key: "child-closed",
          event: "child.closed",
          next: { routes: [{ kind: "step", to: plan.key, on: "workItem" }] },
        },
      ]);
      const labelled = childCreate("Labelled", { labels: ["kind:research"] });
      const plain = childCreate("Plain");

      await h.runCreatingChildren(parent, [labelled, plain]);

      expect(
        (await h.tasksOn(labelled.workItemId)).map((task) => task.step),
      ).toEqual([research.key]);
      expect(
        (await h.tasksOn(plain.workItemId)).map((task) => task.step),
      ).toEqual([plan.key]);
      expect(await h.tasksOn(parent)).toEqual([]);
      expect(await h.activityOf(parent)).toEqual([
        `Automation ${key} · child.created · rule 1: started ${research.key}`,
        `Automation ${key} · child.created · rule 2: skipped`,
        `Automation ${key} · child.created · rule 1: started ${plan.key}`,
        `Automation ${key} · child.created · rule 2: skipped`,
      ]);
    },
  );

  concurrentTest(
    "child.closed starts the step on the parent (.on workItem)",
    async () => {
      const { h, plan } = requireSetup();
      const { key, parent } = await parentWith([
        {
          key: "child-closed",
          event: "child.closed",
          next: { routes: [{ kind: "step", to: plan.key, on: "workItem" }] },
        },
      ]);
      const child = childCreate("Child");
      await h.runCreatingChildren(parent, [child]);

      await h.setState(child.workItemId, "closed");

      expect((await h.tasksOn(parent)).map((task) => task.step)).toEqual([
        plan.key,
      ]);
      expect(await h.activityOf(parent)).toEqual([
        `Automation ${key} · child.closed · rule 1: started ${plan.key}`,
      ]);
    },
  );

  concurrentTest("a closed parent's automations don't run", async () => {
    const { h } = requireSetup();
    const { parent } = await parentWith([researchOnReadyChild()]);
    const child = childCreate("Child");
    await h.runCreatingChildren(parent, [child]);
    await h.setState(child.workItemId, "closed");
    await h.setState(parent, "closed");

    await h.setState(child.workItemId, "open");

    expect(await h.tasksOn(child.workItemId)).toHaveLength(1);
    expect(await h.activityOf(parent)).toHaveLength(1);
  });

  concurrentTest("a full concurrency group is logged as a skip", async () => {
    const { h } = requireSetup();
    const limited = await h.createStep("limited", {
      concurrency: { max: 1, waiting: 0 },
    });
    const { key, parent } = await parentWith([
      {
        key: "child-created",
        event: "child.created",
        next: {
          routes: [{ kind: "step", to: limited.key, on: "workItem" }],
        },
      },
    ]);

    await h.runCreatingChildren(parent, [
      childCreate("First"),
      childCreate("Second"),
    ]);

    expect(await h.tasksOn(parent)).toHaveLength(1);
    expect(await h.activityOf(parent)).toEqual([
      `Automation ${key} · child.created · rule 1: started ${limited.key}`,
      `Automation ${key} · child.created · rule 1: skipped: concurrency group full`,
    ]);
  });

  concurrentTest(
    "a target that throws is logged and rolls back nothing else",
    async () => {
      const { h, plan } = requireSetup();
      const doomed = await h.createStep("doomed");
      const { key, parent } = await parentWith([
        {
          key: "doomed",
          event: "child.created",
          next: { routes: [{ kind: "step", to: doomed.key, on: "child" }] },
        },
        {
          key: "plan",
          event: "child.created",
          next: { routes: [{ kind: "step", to: plan.key, on: "child" }] },
        },
      ]);
      await h.archiveStep(doomed);
      const child = childCreate("Survivor");

      await h.runCreatingChildren(parent, [child]);

      expect(
        (await h.tasksOn(child.workItemId)).map((task) => task.step),
      ).toEqual([plan.key]);
      expect(await h.activityOf(parent)).toEqual([
        `Automation ${key} · child.created · rule 1: failed: No active step definition has the key ${doomed.key}`,
        `Automation ${key} · child.created · rule 2: started ${plan.key}`,
      ]);
    },
  );

  concurrentTest(
    "a pipeline target starts a run, and an open run is a skip",
    async () => {
      const { h, plan } = requireSetup();
      const pipeline = await h.createPipeline(plan);
      const { key, parent } = await parentWith([
        {
          key: "child-created",
          event: "child.created",
          next: {
            routes: [{ kind: "pipeline", to: pipeline.key, on: "workItem" }],
          },
        },
      ]);

      await h.runCreatingChildren(parent, [
        childCreate("First"),
        childCreate("Second"),
      ]);

      expect(await h.activityOf(parent)).toEqual([
        `Automation ${key} · child.created · rule 1: started pipeline ${pipeline.key}`,
        `Automation ${key} · child.created · rule 1: skipped: a pipeline run is already open`,
      ]);
    },
  );

  concurrentTest(
    "a started step Task records its automation, until the automation is deleted",
    async () => {
      const { h, plan } = requireSetup();
      const { key, parent } = await parentWith([
        {
          key: "self-attached",
          event: "self.attached",
          next: { routes: [{ kind: "step", to: plan.key, on: "workItem" }] },
        },
      ]);
      await h.attach(parent, key);
      const [task] = await h.tasksOn(parent);
      expect(task?.startedByUserId).toBeNull();
      expect(task?.startedBy).toMatchObject({
        kind: "automation",
        key,
        title: `Automation ${key}`,
      });

      await h.deleteAutomation(key);

      expect((await h.tasksOn(parent))[0]?.startedBy).toEqual({
        kind: "system",
      });
    },
  );

  concurrentTest(
    "a started pipeline run and its step Task record the automation, and keep the run once it is deleted",
    async () => {
      const { h, plan } = requireSetup();
      const pipeline = await h.createPipeline(plan);
      const { key, parent } = await parentWith([
        {
          key: "child-created",
          event: "child.created",
          next: {
            routes: [{ kind: "pipeline", to: pipeline.key, on: "workItem" }],
          },
        },
      ]);
      await h.runCreatingChildren(parent, [childCreate("Only")]);
      const startedByAutomation = {
        kind: "automation",
        key,
        title: `Automation ${key}`,
      };

      const [run] = await h.runsOn(parent);
      expect(run?.triggeredByUserId).toBeNull();
      expect(run?.startedBy).toMatchObject(startedByAutomation);
      const [task] = await h.tasksOn(parent);
      expect(task?.step).toBe(plan.key);
      expect(task?.startedBy).toMatchObject(startedByAutomation);

      await h.deleteAutomation(key);

      expect(await h.runsOn(parent)).toMatchObject([
        { id: run?.id, startedBy: { kind: "system" } },
      ]);
      expect((await h.tasksOn(parent))[0]?.startedBy).toEqual({
        kind: "system",
      });
    },
  );
});
