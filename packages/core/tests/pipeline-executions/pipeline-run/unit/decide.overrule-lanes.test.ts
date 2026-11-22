import { describe, expect, test } from "bun:test";
import { RunSimulator } from "./engine-harness";
import { clone, type Doc } from "./engine-fixtures";
import { triageDocument, triageSteps } from "./engine-fixtures-all";
import { itemsPipeline, itemSteps } from "./engine-fixtures-items";
import { nextOf, type Json } from "./engine-fixtures-overrule";

/**
 * The items pipeline with an overridable judgement in each lane: an approved
 * review arrives at the merge, otherwise the file is edited again (or, with
 * `otherwise: false`, the lane's path ends).
 */
function reviewedItems(options: { otherwise: boolean }): Doc {
  const document = clone(itemsPipeline());
  const next = nextOf(document, "review-edit");
  next["overridable"] = true;
  (next.routes[0] as Json)["when"] = {
    path: "result.approved",
    op: "equal",
    value: true,
  };
  if (options.otherwise) {
    next["otherwise"] = {
      to: "edit-file",
      args: {
        file: "input.path",
        planSummary: "nodes.plan-changes.result.summary",
      },
    };
  }
  return document;
}

function itemsRun(document: Doc) {
  const run = new RunSimulator(document, itemSteps).start();
  run.succeed("plan-changes", { files: ["a", "b"], summary: "s", count: 2 });
  return run;
}

function review(run: RunSimulator, item: number, approved: boolean): string {
  run.succeed("edit-file", { path: `p${String(item)}`, diff: "+" }, { item });
  run.succeed("review-edit", { approved, confidence: 0.9 }, { item });
  return run.visits("review-edit", { item }).at(-1)?.id as string;
}

/** The items pipeline where `plan-changes` only edits files when it counted some; otherwise the run fails. */
function gatedPlan(): Doc {
  const document = clone(itemsPipeline());
  const next = nextOf(document, "plan-changes");
  next["overridable"] = true;
  (next.routes[0] as Json)["when"] = {
    path: "result.count",
    op: "greaterThan",
    value: 0,
  };
  next["otherwise"] = { to: "changes-rejected" };
  return document;
}

describe("decide: overrules in lanes", () => {
  test.concurrent(
    "inside an each lane, a partial route arrives at its merge",
    () => {
      const run = itemsRun(reviewedItems({ otherwise: true }));
      const rejected = review(run, 0, false);
      const editAgain = run.latestTaskId(run.open("edit-file", 0).id);
      run.overrule(rejected, [{ kind: "route", index: 0 }]);
      expect(run.cancelledTasks()).toEqual([editAgain]);
      expect(run.visits("edit-file", { item: 0 }).at(-1)?.status).toBe(
        "superseded",
      );
      expect(run.laneStatuses()).toEqual(["arrived", "active"]);
      review(run, 1, true);
      expect(run.open("approve-reviews").input).toEqual({
        reviews: [
          { approved: false, confidence: 0.9 },
          { approved: true, confidence: 0.9 },
        ],
      });
    },
  );

  test.concurrent("a lane that ended goes back to active and arrives", () => {
    const run = itemsRun(reviewedItems({ otherwise: false }));
    const rejected = review(run, 0, false);
    expect(run.laneStatuses()).toEqual(["ended", "active"]);
    run.overrule(rejected, [{ kind: "route", index: 0 }]);
    expect(run.laneStatuses()).toEqual(["arrived", "active"]);
  });

  test.concurrent(
    "after the merge fired, the merge is superseded and the group reopens",
    () => {
      const run = itemsRun(reviewedItems({ otherwise: true }));
      const approved = review(run, 0, true);
      review(run, 1, true);
      const merge = run.open("approve-reviews");
      expect(run.state.laneGroups[0]?.status).toBe("merged");
      run.overrule(approved, [{ kind: "otherwise", index: 0 }]);
      expect(run.visits("approve-reviews")[0]?.status).toBe("superseded");
      expect(run.state.laneGroups[0]?.status).toBe("open");
      expect(run.laneStatuses()).toEqual(["active", "arrived"]);
      expect(run.open("edit-file", 0).input).toEqual({
        file: "p0",
        planSummary: "s",
      });
      review(run, 0, true);
      expect(run.open("approve-reviews").id).not.toBe(merge.id);
      expect(run.state.laneGroups[0]?.status).toBe("merged");
    },
  );

  test.concurrent("overruling to a route that spawns each", () => {
    const run = new RunSimulator(gatedPlan(), itemSteps).start();
    run.succeed("plan-changes", { files: ["a", "b"], summary: "s", count: 0 });
    expect(run.state.run.status).toBe("failed");
    const plan = run.visits("plan-changes")[0]?.id as string;
    run.overrule(plan, [{ kind: "route", index: 0 }]);
    expect(run.visits("changes-rejected")[0]?.status).toBe("superseded");
    expect(run.state.run.status).toBe("active");
    expect(run.state.laneGroups).toHaveLength(1);
    expect(run.open("edit-file", 1).input).toEqual({
      file: "b",
      planSummary: "s",
    });
  });

  test.concurrent(
    "overruling a visit that spawned each cancels its lanes",
    () => {
      const run = new RunSimulator(gatedPlan(), itemSteps).start();
      run.succeed("plan-changes", {
        files: ["a", "b"],
        summary: "s",
        count: 2,
      });
      const tasks = [0, 1].map((item) =>
        run.latestTaskId(run.open("edit-file", item).id),
      );
      const plan = run.visits("plan-changes")[0]?.id as string;
      run.overrule(plan, [{ kind: "otherwise", index: 0 }]);
      expect(run.cancelledTasks().sort()).toEqual([...tasks].sort());
      expect(run.laneStatuses()).toEqual(["cancelled", "cancelled"]);
      expect(run.trail()).toEqual([
        "plan-changes:succeeded",
        "edit-file#0:superseded",
        "edit-file#1:superseded",
        "changes-rejected:failed",
      ]);
      expect(run.state.run.status).toBe("failed");
    },
  );

  test.concurrent(
    "a partial merge's visit keeps its continuation lane and arrives",
    () => {
      const document = clone(triageDocument());
      const route = nextOf(document, "write-failing-test").routes[0] as Json;
      route["when"] = { not: { path: "result.testPath", op: "isEmpty" } };
      route["overridable"] = true;
      const run = new RunSimulator(document, triageSteps).start();
      run.succeed("classify-issue", {
        appUrl: "https://app.test",
        category: "security",
        summary: "s",
        affectedPages: ["/cart"],
        duplicateCount: 0,
        duplicateIds: [],
      });
      run.succeed("reproduce-in-browser", {
        reproduced: true,
        observedBehavior: "500",
      });
      run.succeed("notify-security", { notified: true });
      run.decide("security-sign-off", "approve", "fine");
      run.succeed("write-failing-test", { testPath: "" });
      const continuations = () =>
        run.state.lanes.filter((lane) => lane.origin === "merge");
      expect(continuations().map((lane) => lane.status)).toEqual(["ended"]);
      const written = run.visits("write-failing-test")[0]?.id as string;
      run.overrule(written, [{ kind: "route", index: 0 }]);
      expect(continuations()).toMatchObject([
        { status: "arrived", arrivedFromVisitId: written },
      ]);
      run.succeed("capture-screenshot", { url: "s/cart.png" }, { item: 0 });
      expect(run.open("summarise").input).toEqual({
        failingTest: "",
        screenshots: ["s/cart.png"],
      });
    },
  );
});
