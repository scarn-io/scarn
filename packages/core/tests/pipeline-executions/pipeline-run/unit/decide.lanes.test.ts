import { describe, expect, test } from "bun:test";
import { RunSimulator } from "./engine-harness";
import { clone } from "./engine-fixtures";
import { itemsPipeline, itemSteps } from "./engine-fixtures-items";

const files = ["a.ts", "b.ts", "c.ts"];

function itemsRun(
  options: {
    files?: string[];
    maxConcurrency?: number;
    toleratedFailures?: object;
  } = {},
) {
  const document = clone(itemsPipeline());
  const plan = document.nodes["plan-changes"] as {
    next: { routes: { each: { maxConcurrency?: number } }[] };
  };
  const each = plan.next.routes[0]?.each as { maxConcurrency?: number };
  if (options.maxConcurrency === undefined) {
    each.maxConcurrency = 5;
  } else {
    each.maxConcurrency = options.maxConcurrency;
  }
  if (options.toleratedFailures !== undefined) {
    Object.assign(each, { toleratedFailures: options.toleratedFailures });
  }
  const run = new RunSimulator(document, itemSteps).start();
  run.succeed(
    "plan-changes",
    { files: options.files ?? files, summary: "rename" },
    { workBranch: "plan" },
  );
  return run;
}

function finishLane(
  run: RunSimulator,
  item: number,
  approved = true,
  branch = "lane",
) {
  run.succeed(
    "edit-file",
    { path: `f${String(item)}`, diff: "+" },
    { item, workBranch: branch },
  );
  run.succeed("review-edit", { approved, confidence: 0.9 }, { item });
}

describe("decide: items pipeline lanes", () => {
  test.concurrent(
    "each creates a group, one lane per item, with resolved item args",
    () => {
      const run = itemsRun();
      expect(run.state.laneGroups).toHaveLength(1);
      expect(run.state.laneGroups[0]).toMatchObject({
        laneCount: 3,
        maxConcurrency: 5,
        toleratedFailures: { count: 0 },
        status: "open",
        parentLaneId: null,
        spawnedByVisitId: run.visits("plan-changes")[0]?.id,
      });
      expect(run.laneStatuses()).toEqual(["active", "active", "active"]);
      expect(run.open("edit-file", 1).input).toEqual({
        file: "b.ts",
        planSummary: "rename",
      });
      expect(run.queued().map((task) => task.baseBranch)).toEqual([
        "plan",
        "plan",
        "plan",
      ]);
      const order = run.last.commands.map((command) => command.type);
      expect(order.indexOf("createLaneGroup")).toBeLessThan(
        order.indexOf("createVisit"),
      );
    },
  );

  test.concurrent(
    "the merge fires once every lane arrived, with arrays concatenated in item order",
    () => {
      const run = itemsRun();
      finishLane(run, 2);
      finishLane(run, 0);
      expect(run.visits("approve-reviews")).toEqual([]);
      expect(run.laneStatuses()).toEqual(["arrived", "active", "arrived"]);
      expect(run.state.lanes[2]).toMatchObject({
        arrivedAtNodeId: "approve-reviews",
        arrivalArgs: { reviews: [{ approved: true, confidence: 0.9 }] },
        arrivalTransition: { kind: "route", index: 0 },
        mergedIntoVisitId: null,
      });
      finishLane(run, 1);
      const approval = run.open("approve-reviews");
      expect(approval).toMatchObject({
        laneId: null,
        fromVisitId: null,
        fromLaneGroupId: run.state.laneGroups[0]?.id,
        transition: { kind: "merge", index: 0 },
      });
      expect(approval.input).toEqual({
        reviews: [0, 1, 2].map(() => ({ approved: true, confidence: 0.9 })),
      });
      expect(run.state.laneGroups[0]?.status).toBe("merged");
      expect(run.state.lanes.map((lane) => lane.mergedIntoVisitId)).toEqual([
        approval.id,
        approval.id,
        approval.id,
      ]);
      run.decide("approve-reviews", "approve");
      expect(run.open("open-pr").input).toEqual({
        request: "Checkout crashes",
        reviews: [0, 1, 2].map(() => ({ approved: true, confidence: 0.9 })),
      });
      expect(run.queued()[0]?.baseBranch).toBe("lane");
      run.succeed("open-pr", { url: "u" });
      expect(run.state.run).toMatchObject({
        status: "succeeded",
        endNodeId: "done",
      });
    },
  );

  test.concurrent(
    "arrays from each lane are concatenated in item order",
    () => {
      const document = clone(itemsPipeline());
      const review = document.nodes["review-edit"] as {
        next: { routes: { args: object }[] };
      };
      (review.next.routes[0] as { args: object }).args = {
        reviews: { list: ["result", "result"] },
      };
      const run = new RunSimulator(document, itemSteps).start();
      run.succeed("plan-changes", { files: ["a", "b"], summary: "s" });
      run.succeed("edit-file", { path: "b", diff: "+" }, { item: 1 });
      run.succeed(
        "review-edit",
        { approved: false, confidence: 1 },
        { item: 1 },
      );
      run.succeed("edit-file", { path: "a", diff: "+" }, { item: 0 });
      run.succeed(
        "review-edit",
        { approved: true, confidence: 0 },
        { item: 0 },
      );
      expect(
        (
          run.open("approve-reviews").input["reviews"] as {
            confidence: number;
          }[]
        ).map((review) => review.confidence),
      ).toEqual([0, 0, 1, 1]);
    },
  );

  test.concurrent("the merge's approval branches on the merged list", () => {
    const run = itemsRun({ files: ["a.ts", "b.ts"] });
    finishLane(run, 0, true);
    finishLane(run, 1, false);
    expect(run.state.run.status).toBe("waiting");
    run.decide("approve-reviews", "reject");
    expect(run.state.run).toMatchObject({
      status: "failed",
      endNodeId: "changes-rejected",
    });
  });

  test.concurrent(
    "base branch after a merge is null and noted when lanes disagree",
    () => {
      const run = itemsRun({ files: ["a.ts", "b.ts"] });
      finishLane(run, 0, true, "one");
      finishLane(run, 1, true, "two");
      run.decide("approve-reviews", "approve");
      expect(run.queued()[0]?.baseBranch).toBeNull();
      expect(run.open("open-pr").routing?.notes).toEqual([
        { kind: "branch_ambiguous", branches: ["one", "two"] },
      ]);
    },
  );

  test.concurrent(
    "the branch note survives the visit taking its next route",
    () => {
      const run = itemsRun({ files: ["a.ts", "b.ts"] });
      finishLane(run, 0, true, "one");
      finishLane(run, 1, true, "two");
      run.decide("approve-reviews", "approve");
      const openPrId = run.open("open-pr").id;
      run.succeed("open-pr", { url: "u" });
      const openPr = run.visits("open-pr").find((v) => v.id === openPrId);
      expect(openPr?.routing).toMatchObject({
        notes: [{ kind: "branch_ambiguous", branches: ["one", "two"] }],
        taken: [{ kind: "route", index: 0 }],
      });
    },
  );

  test.concurrent("an empty each merges straight away with []", () => {
    const run = itemsRun({ files: [] });
    expect(run.state.lanes).toEqual([]);
    expect(run.state.laneGroups[0]?.status).toBe("merged");
    expect(run.open("approve-reviews").input).toEqual({ reviews: [] });
  });
});

describe("decide: max concurrency", () => {
  test.concurrent(
    "starts the lowest-indexed pending lane as each lane finishes",
    () => {
      const run = itemsRun({ files: ["a", "b", "c", "d"], maxConcurrency: 2 });
      expect(run.laneStatuses()).toEqual([
        "active",
        "active",
        "pending",
        "pending",
      ]);
      expect(run.queued()).toHaveLength(2);
      finishLane(run, 1);
      expect(run.laneStatuses()).toEqual([
        "active",
        "arrived",
        "active",
        "pending",
      ]);
      expect(run.open("edit-file", 2).input["file"]).toBe("c");
      run.fail("edit-file", { item: 0 });
      expect(run.state.laneGroups[0]?.status).toBe("failed");
    },
  );

  test.concurrent(
    "a tolerated failure also starts the next pending lane",
    () => {
      const run = itemsRun({
        files: ["a", "b", "c"],
        maxConcurrency: 1,
        toleratedFailures: { count: 1 },
      });
      run.fail("edit-file", { item: 0 });
      expect(run.laneStatuses()).toEqual(["failed", "active", "pending"]);
      finishLane(run, 1);
      finishLane(run, 2);
      expect(run.open("approve-reviews").input["reviews"]).toHaveLength(2);
    },
  );
});

describe("decide: lane failure threshold", () => {
  test.concurrent(
    "exceeding toleratedFailures fails the group, cancels lanes and Tasks, and fails the run",
    () => {
      const run = itemsRun({ files: ["a", "b", "c", "d"], maxConcurrency: 3 });
      const activeTasks = [1, 2].map((item) =>
        run.latestTaskId(run.open("edit-file", item).id),
      );
      run.fail("edit-file", { item: 0, message: "bad" });
      expect(run.laneStatuses()).toEqual([
        "failed",
        "cancelled",
        "cancelled",
        "cancelled",
      ]);
      expect(run.cancelledTasks().sort()).toEqual(activeTasks.sort());
      expect(run.state.laneGroups[0]?.status).toBe("failed");
      expect(run.state.run).toMatchObject({
        status: "failed",
        error: { name: "Scarn.LanesFailed", message: "1 of 4 lanes failed" },
      });
      const late = run.succeedTask(activeTasks[0] as string, { path: "x" });
      expect(late.commands).toEqual([]);
      expect(late.ignored?.message).toContain("cancelled");
    },
  );

  test.concurrent("percent tolerance counts against the item count", () => {
    const run = itemsRun({
      files: ["a", "b", "c", "d"],
      toleratedFailures: { percent: 50 },
    });
    run.fail("edit-file", { item: 0 });
    run.fail("edit-file", { item: 1 });
    expect(run.state.laneGroups[0]?.status).toBe("open");
    run.fail("edit-file", { item: 2 });
    expect(run.state.laneGroups[0]?.status).toBe("failed");
  });

  test.concurrent(
    "a fail node in a lane fails the lane; succeed ends it and leaves it out of the merge",
    () => {
      const document = clone(itemsPipeline());
      document.nodes["edit-file"] = {
        kind: "step",
        step: "edit-file",
        next: {
          routes: [
            {
              when: { path: "result.diff", op: "equal", value: "" },
              to: "skip",
            },
            {
              when: { path: "result.diff", op: "equal", value: "!" },
              to: "broken",
            },
          ],
          otherwise: {
            to: "review-edit",
            args: { path: "result.path", diff: "result.diff" },
          },
        },
      };
      document.nodes["skip"] = { kind: "succeed" };
      document.nodes["broken"] = { kind: "fail", error: "Broken" };
      const plan = document.nodes["plan-changes"] as {
        next: { routes: { each: object }[] };
      };
      Object.assign(plan.next.routes[0]?.each ?? {}, {
        toleratedFailures: { count: 1 },
      });
      const run = new RunSimulator(document, itemSteps).start();
      run.succeed("plan-changes", { files: ["a", "b", "c"], summary: "s" });
      run.succeed("edit-file", { path: "a", diff: "" }, { item: 0 });
      run.succeed("edit-file", { path: "b", diff: "!" }, { item: 1 });
      expect(run.laneStatuses()).toEqual(["ended", "failed", "active"]);
      expect(run.state.run.status).toBe("active");
      finishLane(run, 2);
      expect(run.open("approve-reviews").input["reviews"]).toEqual([
        { approved: true, confidence: 0.9 },
      ]);
    },
  );
});
