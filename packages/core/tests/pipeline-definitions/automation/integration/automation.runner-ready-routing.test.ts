import { describe, expect } from "bun:test";
import type { UuidV7 } from "@/common/contracts/uuid-v7";
import { parseWorkItemId } from "@/work-items/work-item/domain/work-item-id";
import { concurrentTest, unwrapAsync } from "tests/utils";
import {
  createRunnerHarness,
  projectAutomation,
  uniqueKey,
  type RunnerHarness,
} from "./automation-runner-test-support";

/** Publishes and enables a project automation with one `workItem.ready` rule. */
const enableOnReady = async (h: RunnerHarness, next: object) => {
  const key = uniqueKey("default");
  await h.publish(projectAutomation(key, [{ event: "workItem.ready", next }]));
  await h.enable(key);
  return key;
};

const pipelineTo = (key: string) => ({
  kind: "pipeline",
  to: key,
  on: "workItem",
});

const fieldIs = (name: string, value: string) => ({
  path: `event.workItem.fields.${name}`,
  op: "equal",
  value,
});

const newPipeline = async (h: RunnerHarness) =>
  await h.createPipeline(await h.createStep("triage"));

const cancelRuns = async (h: RunnerHarness, workItemId: UuidV7) => {
  for (const run of await h.runsOn(workItemId)) {
    await unwrapAsync(
      h.apiClient.api["pipeline-executions"]({
        pipelineExecutionId: run.id,
      }).cancel.put(undefined, { headers: h.headers }),
    );
  }
};

const jiraKey = () => `ACME-${crypto.randomUUID().slice(0, 8)}`;

/**
 * A project automation on `workItem.ready` is how a project starts its
 * pipeline on new work. It fires for a top-level item that is open with no
 * open blockers: when created ready, when its last blocker closes, and when
 * it reopens. A plain re-upsert of an existing item fires nothing, so a
 * field change on an existing item starts no work. Each test has its own
 * project, since an enabled project automation sees every item in it.
 */
describe("project automations on workItem.ready", () => {
  concurrentTest(
    "POST /work-items starts one system-triggered run of the pipeline",
    async () => {
      const h = await createRunnerHarness("ready-post");
      const pipeline = await newPipeline(h);
      await enableOnReady(h, { routes: [pipelineTo(pipeline.key)] });

      const item = await h.createItem();

      expect(await h.runsOn(item)).toMatchObject([
        { pipelineId: pipeline.id, triggeredByUserId: null },
      ]);
    },
  );

  concurrentTest(
    "upserts route on fields: a bug gets one run, a resolved one none, a re-upsert no second",
    async () => {
      const h = await createRunnerHarness("ready-upsert");
      const pipeline = await newPipeline(h);
      const key = await enableOnReady(h, {
        routes: [
          {
            when: {
              any: [
                fieldIs("status", "resolved"),
                fieldIs("status", "manual support"),
              ],
            },
            kind: "skip",
          },
          { when: fieldIs("issueType", "bug"), ...pipelineTo(pipeline.key) },
        ],
        otherwise: { kind: "skip" },
      });
      const bugKey = jiraKey();
      const openBug = { status: "open", issueType: "bug" };

      const bug = await h.putItem(bugKey, openBug);
      const resolved = await h.putItem(jiraKey(), {
        status: "resolved",
        issueType: "bug",
      });
      const task = await h.putItem(jiraKey(), {
        status: "open",
        issueType: "task",
      });
      expect(await h.putItem(bugKey, openBug)).toBe(bug);

      expect(await h.runsOn(bug)).toHaveLength(1);
      expect(await h.runsOn(resolved)).toEqual([]);
      expect(await h.runsOn(task)).toEqual([]);
      expect(await h.activityOf(bug)).toEqual([
        `Automation ${key} · workItem.ready · rule 1: started pipeline ${pipeline.key}`,
      ]);
      expect(await h.activityOf(resolved)).toEqual([
        `Automation ${key} · workItem.ready · rule 1: skipped`,
      ]);
    },
  );

  concurrentTest(
    "an existing item that becomes a bug on re-upsert gets nothing",
    async () => {
      const h = await createRunnerHarness("ready-field-change");
      const pipeline = await newPipeline(h);
      const key = await enableOnReady(h, {
        routes: [
          { when: fieldIs("issueType", "bug"), ...pipelineTo(pipeline.key) },
        ],
        otherwise: { kind: "skip" },
      });
      const platformKey = jiraKey();

      const item = await h.putItem(platformKey, { issueType: "task" });
      await h.putItem(platformKey, { issueType: "bug" });

      expect(await h.runsOn(item)).toEqual([]);
      expect(await h.activityOf(item)).toEqual([
        `Automation ${key} · workItem.ready · rule 1: skipped`,
      ]);
    },
  );

  concurrentTest("the first matching route wins, else otherwise", async () => {
    const h = await createRunnerHarness("ready-first-match");
    const routed = await newPipeline(h);
    const fallback = await newPipeline(h);
    await enableOnReady(h, {
      routes: [
        {
          when: fieldIs("issueType", "performance"),
          ...pipelineTo(routed.key),
        },
        { when: fieldIs("priority", "high"), kind: "skip" },
      ],
      otherwise: pipelineTo(fallback.key),
    });

    const performance = await h.putItem(jiraKey(), {
      issueType: "performance",
      priority: "high",
    });
    const other = await h.putItem(jiraKey(), { issueType: "bug" });

    expect(await h.runsOn(performance)).toMatchObject([
      { pipelineId: routed.id },
    ]);
    expect(await h.runsOn(other)).toMatchObject([{ pipelineId: fallback.id }]);
  });

  concurrentTest(
    "a child and a blocked item get nothing; the blocked one starts when its last blocker closes",
    async () => {
      const h = await createRunnerHarness("ready-blocked");
      const pipeline = await newPipeline(h);
      const parent = await h.createItem("Parent");
      const child = await h.createItem("Child");
      await unwrapAsync(
        h.apiClient.api["work-items"]({ workItemId: child }).parent.patch(
          { parentWorkItemId: parseWorkItemId(parent) },
          { headers: h.headers },
        ),
      );
      const blocked = await h.createItem("Blocked");
      const first = await h.createItem("First blocker");
      const second = await h.createItem("Second blocker");
      await h.block(blocked, first);
      await h.block(blocked, second);
      await enableOnReady(h, { routes: [pipelineTo(pipeline.key)] });

      await h.setState(child, "closed");
      await h.setState(child, "open");
      await h.setState(blocked, "closed");
      await h.setState(blocked, "open");
      await h.setState(first, "closed");

      expect(await h.runsOn(child)).toEqual([]);
      expect(await h.runsOn(blocked)).toEqual([]);

      await h.setState(second, "closed");

      expect(await h.runsOn(blocked)).toMatchObject([
        { pipelineId: pipeline.id },
      ]);
    },
  );

  concurrentTest(
    "a reopened item fires workItem.ready again and gets a new run",
    async () => {
      const h = await createRunnerHarness("ready-reopen");
      const pipeline = await newPipeline(h);
      const key = await enableOnReady(h, {
        routes: [pipelineTo(pipeline.key)],
      });
      const item = await h.createItem();
      await cancelRuns(h, item);

      await h.setState(item, "closed");
      await h.setState(item, "open");

      expect(await h.runsOn(item)).toMatchObject([
        { pipelineId: pipeline.id },
        { pipelineId: pipeline.id },
      ]);
      const started = `Automation ${key} · workItem.ready · rule 1: started pipeline ${pipeline.key}`;
      expect(await h.activityOf(item)).toEqual([started, started]);
    },
  );

  concurrentTest(
    "a step target starts a standalone Task with no input and no user, again on reopen",
    async () => {
      const h = await createRunnerHarness("ready-step");
      const triage = await h.createStep("triage");
      await enableOnReady(h, {
        routes: [{ kind: "step", to: triage.key, on: "workItem" }],
      });
      const platformKey = jiraKey();

      const item = await h.putItem(platformKey, {});
      await h.putItem(platformKey, {});

      expect(await h.tasksOn(item)).toMatchObject([
        {
          step: triage.key,
          status: "queued",
          inputJson: null,
          startedByUserId: null,
        },
      ]);
      expect(await h.runsOn(item)).toEqual([]);

      await h.setState(item, "closed");
      await h.setState(item, "open");

      expect((await h.tasksOn(item)).map((task) => task.step)).toEqual([
        triage.key,
        triage.key,
      ]);
    },
  );
});
