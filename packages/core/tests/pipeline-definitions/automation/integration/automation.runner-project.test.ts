import { describe, expect } from "bun:test";
import { concurrentTest } from "tests/utils";
import {
  childCreate,
  createRunnerHarness,
  projectAutomation,
  uniqueKey,
  workItemAutomation,
} from "./automation-runner-test-support";

const questionInput = {
  type: "object",
  properties: { question: { type: "string" } },
  required: ["question"],
  additionalProperties: false,
};

/**
 * Project automations run, once enabled, on events about the project's
 * top-level work items, in key order. Each test has its own project, since
 * an enabled project automation sees every work item in it.
 */
describe("project automations", () => {
  concurrentTest(
    "workItem.created and workItem.ready fire for top-level items, not children",
    async () => {
      const h = await createRunnerHarness("project-events");
      const research = await h.createStep("research", {
        inputSchemaJson: questionInput,
      });
      const plan = await h.createStep("plan");
      const key = uniqueKey("triage");
      await h.publish(
        projectAutomation(key, [
          {
            key: "work-item-created",
            event: "workItem.created",
            next: { routes: [{ kind: "step", to: plan.key, on: "workItem" }] },
          },
          {
            key: "work-item-ready",
            event: "workItem.ready",
            next: {
              routes: [
                {
                  kind: "step",
                  to: research.key,
                  args: { question: "event.workItem.title" },
                  on: "workItem",
                },
              ],
            },
          },
        ]),
      );
      await h.enable(key);

      const item = await h.createItem("Top level");

      expect(await h.tasksOn(item)).toMatchObject([
        { step: plan.key },
        { step: research.key, inputJson: { question: "Top level" } },
      ]);
      const topLevelLines = [
        `Automation ${key} · workItem.created · rule 1: started ${plan.key}`,
        `Automation ${key} · workItem.ready · rule 2: started ${research.key}`,
      ];
      expect(await h.activityOf(item)).toEqual(topLevelLines);

      const child = childCreate("Child");
      await h.runCreatingChildren(item, [child]);

      expect(await h.tasksOn(child.workItemId)).toEqual([]);
      expect(await h.activityOf(child.workItemId)).toEqual([]);
      expect(await h.activityOf(item)).toEqual(topLevelLines);
    },
  );

  concurrentTest("project automations run in key order", async () => {
    const h = await createRunnerHarness("project-order");
    const prefix = uniqueKey("ordered");
    const first = `${prefix}-a`;
    const second = `${prefix}-b`;
    for (const key of [second, first]) {
      await h.publish(
        projectAutomation(key, [
          {
            key: "work-item-created",
            event: "workItem.created",
            next: { routes: [{ kind: "skip" }] },
          },
        ]),
      );
      await h.enable(key);
    }

    const item = await h.createItem();

    expect(await h.activityOf(item)).toEqual([
      `Automation ${first} · workItem.created · rule 1: skipped`,
      `Automation ${second} · workItem.created · rule 1: skipped`,
    ]);
  });

  concurrentTest("a disabled project automation doesn't run", async () => {
    const h = await createRunnerHarness("project-disabled");
    const key = uniqueKey("dormant");
    await h.publish(
      projectAutomation(key, [
        {
          key: "work-item-created",
          event: "workItem.created",
          next: { routes: [{ kind: "skip" }] },
        },
      ]),
    );

    const item = await h.createItem();

    expect(await h.activityOf(item)).toEqual([]);
  });

  concurrentTest(
    "workItem.label.added fires per added label, from sync and from PATCH labels",
    async () => {
      const h = await createRunnerHarness("project-labels");
      const research = await h.createStep("research", {
        inputSchemaJson: questionInput,
      });
      const key = uniqueKey("labels");
      await h.publish(
        projectAutomation(key, [
          {
            key: "work-item-label-added",
            event: "workItem.label.added",
            next: {
              routes: [
                {
                  when: { path: "event.label", op: "equal", value: "triage" },
                  kind: "step",
                  to: research.key,
                  args: { question: "event.label" },
                  on: "workItem",
                },
              ],
              otherwise: { kind: "skip" },
            },
          },
        ]),
      );
      await h.enable(key);
      const started = `Automation ${key} · workItem.label.added · rule 1: started ${research.key}`;
      const skipped = `Automation ${key} · workItem.label.added · rule 1: skipped`;

      const platformKey = `SYNC-${crypto.randomUUID().slice(0, 8)}`;
      const synced = await h.syncItem(platformKey, ["triage", "other"]);
      expect(await h.activityOf(synced)).toEqual([started, skipped]);
      expect(await h.tasksOn(synced)).toMatchObject([
        { step: research.key, inputJson: { question: "triage" } },
      ]);

      await h.syncItem(platformKey, ["triage", "other", "later"]);
      expect(await h.activityOf(synced)).toEqual([started, skipped, skipped]);

      const patched = await h.createItem();
      await h.addLabels(patched, ["triage"]);
      expect(await h.activityOf(patched)).toEqual([started]);
    },
  );

  concurrentTest(
    "an attach target fires the attached automation's self.attached",
    async () => {
      const h = await createRunnerHarness("project-attach");
      const plan = await h.createStep("plan");
      const workKey = uniqueKey("wayfinder");
      const projectKey = uniqueKey("router");
      await h.publish(
        workItemAutomation(workKey, [
          {
            key: "self-attached",
            event: "self.attached",
            next: { routes: [{ kind: "step", to: plan.key, on: "workItem" }] },
          },
        ]),
      );
      await h.publish(
        projectAutomation(projectKey, [
          {
            key: "work-item-created",
            event: "workItem.created",
            next: { routes: [{ kind: "attach", automation: workKey }] },
          },
        ]),
      );
      await h.enable(projectKey);

      const item = await h.createItem();

      expect((await h.tasksOn(item)).map((task) => task.step)).toEqual([
        plan.key,
      ]);
      expect(await h.activityOf(item)).toEqual([
        `Automation ${projectKey} · workItem.created · rule 1: attached ${workKey}`,
        `Automation ${workKey} · self.attached · rule 1: started ${plan.key}`,
      ]);

      await h.attach(item, workKey);
      expect(await h.tasksOn(item)).toHaveLength(1);
      expect(await h.activityOf(item)).toHaveLength(2);
    },
  );
});
