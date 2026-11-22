import { describe, expect, test } from "bun:test";
import { RunSimulator } from "./engine-harness";
import { bugPipeline, bugSteps, clone } from "./engine-fixtures";
import { itemSteps, itemsPipeline } from "./engine-fixtures-items";

const evaluation = {
  quality: 0.9,
  hasRumSession: false,
  maxAttempts: 3,
  summary: "crash",
};
const reproduced = {
  reproductionConfidence: 0.9,
  evidenceVerdict: "reproduced",
};

function toProposeFix(document: object) {
  const run = new RunSimulator(document, bugSteps).start();
  run.succeed("evaluate", evaluation);
  run.succeed("reproduce-from-logs", reproduced);
  run.succeed("failing-test", { testPath: "a.test.ts" });
  return run;
}

function toFixDirect(document: object) {
  const run = toProposeFix(document);
  run.succeed("propose-fix", { requiresHumanApproval: false });
  return run;
}

function fixWithoutOtherwise() {
  const document = clone(bugPipeline());
  const fix = document.nodes["fix"] as { next: { otherwise?: object } };
  delete fix.next.otherwise;
  return document;
}

describe("decide: next routes", () => {
  test.concurrent(
    "the matching route is taken and recorded with its kind and index",
    () => {
      const run = toFixDirect(bugPipeline());
      run.succeed("fix", { testsPass: true, attempts: 1 });
      expect(run.visits("fix")[0]?.routing?.taken).toEqual([
        { kind: "route", index: 0 },
      ]);
      expect(run.visits("done")[0]?.transition).toEqual({
        kind: "route",
        index: 0,
      });
    },
  );

  test.concurrent("otherwise is taken when no route matches", () => {
    const run = toFixDirect(bugPipeline());
    run.succeed("fix", { testsPass: false, attempts: 1 });
    expect(run.visits("fix")[0]?.routing?.taken).toEqual([
      { kind: "otherwise", index: 0 },
    ]);
    expect(run.visits("fix")[1]?.transition).toEqual({
      kind: "otherwise",
      index: 0,
    });
  });

  test.concurrent(
    "no match and no otherwise ends the path, which succeeds the run at top level",
    () => {
      const run = toFixDirect(fixWithoutOtherwise());
      run.succeed("fix", { testsPass: false, attempts: 1 });
      expect(run.visits("fix")).toHaveLength(1);
      expect(run.visits("fix")[0]?.routing?.taken).toEqual([]);
      expect(run.state.run).toMatchObject({
        status: "succeeded",
        endNodeId: "fix",
      });
    },
  );

  test.concurrent("a node with no next ends the path", () => {
    const document = clone(bugPipeline());
    delete (document.nodes["fix"] as { next?: object }).next;
    delete document.nodes["done"];
    const run = toFixDirect(document);
    run.succeed("fix", { testsPass: false, attempts: 1 });
    expect(run.state.run).toMatchObject({
      status: "succeeded",
      endNodeId: "fix",
    });
  });

  test.concurrent(
    "no match with otherwise to a fail node fails the run",
    () => {
      const run = toProposeFix(bugPipeline());
      run.succeed("propose-fix", { requiresHumanApproval: true });
      run.decide("approve-fix", "reject");
      expect(run.visits("approve-fix")[0]?.routing?.taken).toEqual([
        { kind: "otherwise", index: 0 },
      ]);
      expect(run.state.run).toMatchObject({
        status: "failed",
        endNodeId: "fix-rejected",
        error: { name: "FixRejected" },
      });
    },
  );

  test.concurrent(
    "no match and no otherwise in a lane ends the lane, which leaves it out of the merge",
    () => {
      const document = clone(itemsPipeline());
      document.nodes["edit-file"] = {
        kind: "step",
        step: "edit-file",
        next: {
          routes: [
            {
              when: { not: { path: "result.diff", op: "isEmpty" } },
              to: "review-edit",
              args: { path: "result.path", diff: "result.diff" },
            },
          ],
        },
      };
      const run = new RunSimulator(document, itemSteps).start();
      run.succeed("plan-changes", { files: ["a", "b"], summary: "s" });
      run.succeed("edit-file", { path: "a", diff: "" }, { item: 0 });
      expect(run.visits("edit-file", { item: 0 })[0]?.routing?.taken).toEqual(
        [],
      );
      expect(run.laneStatuses()).toEqual(["ended", "active"]);
      expect(run.state.run.status).toBe("active");
      run.succeed("edit-file", { path: "b", diff: "+" }, { item: 1 });
      run.succeed(
        "review-edit",
        { approved: true, confidence: 0.9 },
        { item: 1 },
      );
      expect(run.open("approve-reviews").input["reviews"]).toEqual([
        { approved: true, confidence: 0.9 },
      ]);
    },
  );
});
