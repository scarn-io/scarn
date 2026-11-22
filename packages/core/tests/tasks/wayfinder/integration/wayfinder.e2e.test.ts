import { describe, expect } from "bun:test";
import {
  createUuidV7,
  type UuidV7,
} from "@scarn/core/common/contracts/uuid-v7";
import type { TaskStatus } from "@/tasks/task/domain/task-entity";
import { serialTest } from "tests/utils";
import {
  childIn,
  closeOwn,
  createWayfinderHarness,
  line,
} from "./wayfinder-e2e-test-support";

/**
 * The Wayfinder template pushed as a user pushes it and attached to a map,
 * driven the way a worker drives the server: every `plan` round is a fresh
 * Task started by the automation (attach, then each child close), charting
 * labelled child work items whose steps start when they become ready. The
 * `plan` concurrency group (`{ max: 1, waiting: 1 }`) coalesces closes, and
 * the child steps' (`{ max: 1, waiting: 0 }`) drop duplicate starts.
 */
describe("wayfinder end to end", () => {
  const harness = createWayfinderHarness();
  const {
    createRoot,
    attachWayfinder,
    loadItem,
    loadTask,
    runsOf,
    tasksOn,
    taskOn,
    claimLatest,
    workerContext,
    readLive,
    createChild,
    succeed,
    activityOf,
  } = harness;

  const ids = {
    root: "" as UuidV7,
    r1: createUuidV7(),
    r2: createUuidV7(),
    p1: createUuidV7(),
    t1: createUuidV7(),
    g1: createUuidV7(),
  };
  const expectedActivity: string[] = [];
  let round2: Awaited<ReturnType<typeof claimLatest>> | undefined;

  const planTasks = async () =>
    (await tasksOn(ids.root)).filter((task) => task.stepKey === "plan");

  /** The newest `plan` Task, which must be `status`. */
  const latestPlan = async (status: TaskStatus) => {
    const task = (await planTasks()).at(-1);
    expect(task?.status).toBe(status);
    return task?.id as UuidV7;
  };

  /** Claims a fresh `plan` round; it never restores a session. */
  const claimRound = async () => {
    const claimed = await claimLatest(await latestPlan("queued"), "initial");
    expect((await workerContext(claimed)).restoreSession).toBeNull();
    return claimed;
  };

  /** Runs the only Task on a child to success, closing it. */
  const closeChild = async (workItemId: UuidV7, resolution: string) => {
    const task = await taskOn(workItemId);
    const claimed = await claimLatest(task.id as UuidV7, "initial");
    await succeed(claimed, { summary: resolution }, [
      closeOwn(workItemId, resolution),
    ]);
  };

  const expectActivity = async (...added: string[]) => {
    expectedActivity.push(...added);
    expect(await activityOf(ids.root)).toEqual(expectedActivity);
  };

  serialTest(
    "pushing the rendered template publishes four steps and one automation",
    () => {
      expect(harness.pushResult()).toEqual({
        publishedEnvironments: [],
        unchangedEnvironments: [],
        pushedSteps: 4,
        publishedPipelines: [],
        unchangedPipelines: [],
        publishedAutomations: ["wayfinder"],
        unchangedAutomations: [],
        mcpServers: [],
      });
    },
  );

  serialTest(
    "attaching Wayfinder queues one plan Task on the map",
    async () => {
      ids.root = await createRoot("Ship the thing");
      await attachWayfinder(ids.root);

      const [plan, ...others] = await tasksOn(ids.root);
      expect(others).toEqual([]);
      expect(plan).toMatchObject({
        stepKey: "plan",
        status: "queued",
        grants: [
          { resource: "workItem", action: "read", scope: "self" },
          { resource: "workItem", action: "update", scope: "self" },
          {
            resource: "workItem",
            action: "create",
            scope: "children",
            labels: [
              "wayfinder:research",
              "wayfinder:prototype",
              "wayfinder:grilling",
              "wayfinder:task",
            ],
          },
          { resource: "workItem", action: "close", scope: "self" },
        ],
        maxTurns: 30,
      });
      const runs = await runsOf(plan?.id as UuidV7);
      expect(runs.map((run) => [run.status, run.reason])).toEqual([
        ["queued", "initial"],
      ]);
      await expectActivity(line("self.attached", 1, "started plan"));
    },
    30_000,
  );

  serialTest(
    "round 1 charts labelled children; the ready ones with a route start",
    async () => {
      const round1 = await claimRound();
      const map = await readLive(round1, ids.root);
      expect(map).toMatchObject({ descriptionVersion: 1, children: [] });

      await createChild(round1, ids.r1, "wayfinder:research");
      await createChild(round1, ids.r2, "wayfinder:research");
      await createChild(round1, ids.p1, "wayfinder:prototype", [ids.r2]);
      await createChild(round1, ids.t1, "wayfinder:task");
      await succeed(round1, { summary: "Charted R1, R2, P1 and T1." }, [
        {
          kind: "describe",
          workItemId: ids.root,
          description: "Map v1: research R1, R2; prototype P1 after R2; T1.",
          descriptionVersion: 1,
        },
      ]);

      expect((await planTasks()).map((task) => task.status)).toEqual([
        "succeeded",
      ]);
      expect(await loadItem(ids.root)).toMatchObject({ descriptionVersion: 2 });
      for (const id of [ids.r1, ids.r2]) {
        expect(await taskOn(id)).toMatchObject({
          stepKey: "research",
          status: "queued",
        });
      }
      expect(await tasksOn(ids.p1)).toEqual([]);
      expect(await tasksOn(ids.t1)).toEqual([]);
      expect(await harness.childStatusesOf(ids.root)).toEqual({
        [ids.r1]: "running",
        [ids.r2]: "running",
        [ids.p1]: "blocked",
        [ids.t1]: "needs_person",
      });
      await expectActivity(
        line("child.ready", 2, "started research"),
        line("child.ready", 2, "started research"),
      );
    },
    30_000,
  );

  serialTest(
    "R1's close starts round 2 as a fresh plan Task",
    async () => {
      await closeChild(ids.r1, "R1 found X");

      expect((await planTasks()).map((task) => task.status)).toEqual([
        "succeeded",
        "queued",
      ]);
      await expectActivity(line("child.closed", 3, "started plan"));

      round2 = await claimRound();
      const map = await readLive(round2, ids.root);
      expect(map.descriptionVersion).toBe(2);
      expect(childIn(map, ids.r1)).toMatchObject({
        state: "closed",
        resolution: "R1 found X",
        latestTaskStatus: "succeeded",
      });
      expect(childIn(map, ids.t1)).toMatchObject({
        state: "open",
        labels: ["wayfinder:task"],
        blockedBy: [],
        latestTaskStatus: null,
      });
      expect(childIn(map, ids.p1)).toMatchObject({
        blockedBy: [ids.r2],
        latestTaskStatus: null,
      });
    },
    30_000,
  );

  serialTest(
    "R2 closes on its retry, which makes P1 ready and starts the prototype",
    async () => {
      const r2Task = (await taskOn(ids.r2)).id as UuidV7;
      await harness.fail(await claimLatest(r2Task, "initial"), {
        name: "AgentCrashed",
        message: "The agent crashed.",
      });
      expect((await loadTask(r2Task))?.status).toBe("queued");
      await succeed(
        await claimLatest(r2Task, "retry"),
        { summary: "R2 found Y" },
        [closeOwn(ids.r2, "R2 found Y")],
      );

      expect((await runsOf(r2Task)).map((run) => run.status)).toEqual([
        "failed",
        "succeeded",
      ]);
      expect(await taskOn(ids.p1)).toMatchObject({
        stepKey: "prototype",
        status: "queued",
      });
      expect((await planTasks()).map((task) => task.status)).toEqual([
        "succeeded",
        "running",
        "waiting_for_concurrency_slot",
      ]);
      await expectActivity(
        line("child.closed", 3, "started plan"),
        line("child.ready", 2, "started prototype"),
      );
    },
    30_000,
  );

  serialTest(
    "blocking and unblocking P1 while its Task runs drops the second start",
    async () => {
      const prototypeTask = (await taskOn(ids.p1)).id as UuidV7;
      const prototype = await claimLatest(prototypeTask, "initial");

      await harness.unblock(await harness.block(ids.p1, ids.t1));

      expect(await tasksOn(ids.p1)).toHaveLength(1);
      expect((await loadTask(prototypeTask))?.status).toBe("running");
      await expectActivity(
        line("child.ready", 2, "skipped: concurrency group full"),
      );

      await succeed(prototype, { summary: "P1 works" }, [
        closeOwn(ids.p1, "P1 works"),
      ]);
      expect((await loadTask(prototypeTask))?.status).toBe("succeeded");
    },
    30_000,
  );

  serialTest(
    "closes during round 2 coalesce: one plan Task waits and the third is dropped",
    async () => {
      await expectActivity(
        line("child.closed", 3, "skipped: concurrency group full"),
      );
      const afterRound1 = (await planTasks()).slice(1);
      expect(afterRound1.map((task) => task.status)).toEqual([
        "running",
        "waiting_for_concurrency_slot",
      ]);
      expect(await runsOf(afterRound1[1]?.id as UuidV7)).toEqual([]);
    },
    30_000,
  );

  serialTest(
    "a person's map edit refuses round 2's describe; the waiting round redoes it",
    async () => {
      if (!round2) {
        throw new Error("Expected round 2 to be claimed");
      }
      const edited = "Map v2 (a person's edit): also consider S1.";
      await harness.editDescription(ids.root, edited, 2);

      const refused = await succeed(round2, { summary: "Folded R1, R2, P1." }, [
        {
          kind: "describe",
          workItemId: ids.root,
          description: "Map v2: R1 found X, R2 found Y, P1 works.",
          descriptionVersion: 2,
        },
      ]);

      expect(refused.status).toBe("failed");
      expect(refused.errorJson).toMatchObject({
        name: "Scarn.WorkItemChangesInvalid",
      });
      expect(await loadItem(ids.root)).toMatchObject({
        description: edited,
        descriptionVersion: 3,
      });
      expect((await planTasks()).map((task) => task.status)).toEqual([
        "succeeded",
        "failed",
        "queued",
      ]);

      const round3 = await claimRound();
      const map = await readLive(round3, ids.root);
      expect(map.description).toBe(edited);
      await succeed(round3, { summary: "Folded R1, R2 and P1; waiting." }, [
        {
          kind: "describe",
          workItemId: ids.root,
          description: "Map v3: R1 found X, R2 found Y, P1 works; S1 noted.",
          descriptionVersion: map.descriptionVersion,
        },
      ]);
      expect(await latestPlan("succeeded")).toBeDefined();
      expect(await loadItem(ids.root)).toMatchObject({ descriptionVersion: 4 });
      expect(await activityOf(ids.root)).toEqual(expectedActivity);
    },
    30_000,
  );

  serialTest(
    "a person closing T1 by hand with a resolution starts a fresh round",
    async () => {
      await harness.closeByHand(ids.t1, "Signed up; the key is in the vault.");
      await expectActivity(line("child.closed", 3, "started plan"));

      const round4 = await claimRound();
      const map = await readLive(round4, ids.root);
      expect(childIn(map, ids.t1)).toMatchObject({
        state: "closed",
        resolution: "Signed up; the key is in the vault.",
        latestTaskStatus: null,
      });
      await createChild(round4, ids.g1, "wayfinder:grilling");
      await succeed(round4, { summary: "Charted G1." }, [
        {
          kind: "describe",
          workItemId: ids.root,
          description: "Map v4: T1 done; ask who ships it (G1).",
          descriptionVersion: map.descriptionVersion,
        },
      ]);
      await latestPlan("succeeded");
      expect(await taskOn(ids.g1)).toMatchObject({
        stepKey: "grilling",
        status: "queued",
      });
      await expectActivity(line("child.ready", 2, "started grilling"));
    },
    30_000,
  );

  serialTest(
    "grilling hands over to a person, gets a reply and closes",
    async () => {
      const grillingTask = (await taskOn(ids.g1)).id as UuidV7;
      await harness.handOver(
        await claimLatest(grillingTask, "initial"),
        "Ship to whom?",
      );
      const waiting = await loadTask(grillingTask);
      expect(waiting?.status).toBe("waiting_for_person");
      if (!waiting?.conversationId) {
        throw new Error("Expected the grilling Task's conversation");
      }

      await harness.reply(waiting.conversationId, "To everyone.");
      const continued = await claimLatest(grillingTask, "continuation");
      expect((await workerContext(continued)).restoreSession).not.toBeNull();
      await succeed(continued, { summary: "Ship to everyone." }, [
        closeOwn(ids.g1, "Ship to everyone."),
      ]);

      expect((await loadTask(grillingTask))?.status).toBe("succeeded");
      expect(await loadItem(ids.g1)).toMatchObject({ state: "closed" });
      await expectActivity(line("child.closed", 3, "started plan"));
    },
    30_000,
  );

  serialTest(
    "the last round closes the map; a late child close starts nothing",
    async () => {
      const round5 = await claimRound();
      const map = await readLive(round5, ids.root);
      expect(map.children.every((each) => each.state === "closed")).toBe(true);
      await succeed(round5, { summary: "The way is found." }, [
        {
          kind: "describe",
          workItemId: ids.root,
          description: "Map v5. Plan: build it for everyone.",
          descriptionVersion: map.descriptionVersion,
        },
        {
          kind: "close",
          workItemId: ids.root,
          reason: "completed",
          resolution: "The way is found.",
        },
      ]);

      const planTask = await latestPlan("succeeded");
      expect(await loadItem(ids.root)).toMatchObject({
        state: "closed",
        closeReason: "completed",
        closedByTaskId: planTask,
      });

      const tasksBefore = await tasksOn(ids.root);
      await harness.reopen(ids.t1);
      await harness.closeByHand(ids.t1, "Closed again, late.");
      expect(await tasksOn(ids.root)).toEqual(tasksBefore);
      expect(await tasksOn(ids.t1)).toEqual([]);
      await expectActivity();
      expect((await planTasks()).map((task) => task.status)).toEqual([
        "succeeded",
        "failed",
        "succeeded",
        "succeeded",
        "succeeded",
      ]);
    },
    30_000,
  );
});
