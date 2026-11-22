import { describe, expect, test } from "bun:test";
import { DecideError } from "@/pipeline-executions/pipeline-run/domain/engine/types";
import { RunSimulator } from "./engine-harness";
import { bugPipeline, bugSteps } from "./engine-fixtures";
import { itemsPipeline, itemSteps } from "./engine-fixtures-items";

const evaluation = {
  quality: 0.9,
  hasRumSession: false,
  maxAttempts: 3,
  summary: "crash",
  missingDetails: [],
};
const reproduced = {
  reproductionConfidence: 0.9,
  evidenceVerdict: "reproduced",
};
const inconclusive = {
  reproductionConfidence: 0.2,
  evidenceVerdict: "inconclusive",
};

function itemsRun(fileList = ["a", "b"]) {
  const run = new RunSimulator(itemsPipeline(), itemSteps).start();
  run.succeed("plan-changes", { files: fileList, summary: "s" });
  return run;
}

function finishLane(run: RunSimulator, item: number, confidence = 0.9) {
  run.succeed("edit-file", { path: `p${String(item)}`, diff: "+" }, { item });
  run.succeed("review-edit", { approved: true, confidence }, { item });
}

describe("decide: reruns in a linear chain", () => {
  test.concurrent(
    "supersedes the visit and everything after it, re-resolving args from the current work item",
    () => {
      const run = new RunSimulator(bugPipeline(), bugSteps).start();
      run.succeed("evaluate", evaluation);
      run.succeed("reproduce-from-logs", reproduced);
      const reproduceTask = run.latestTaskId(
        run.visits("reproduce-from-logs")[0]?.id as string,
      );
      const failingTestTask = run.latestTaskId(run.open("failing-test").id);
      run.state.workItem.fields = {
        ...run.state.workItem.fields,
        "What are the Company Name(s):": "Globex",
      };
      const target = run.visits("reproduce-from-logs")[0];
      run.rerun(target?.id as string, "try again");
      expect(run.trail()).toEqual([
        "evaluate:succeeded",
        "reproduce-from-logs:superseded",
        "failing-test:superseded",
        "reproduce-from-logs:active",
      ]);
      expect(run.cancelledTasks()).toEqual([failingTestTask]);
      const fresh = run.open("reproduce-from-logs");
      expect(fresh).toMatchObject({
        fromVisitId: target?.fromVisitId,
        transition: target?.transition,
        createdByUserId: "rerunner",
      });
      expect(fresh.input["companyNames"]).toBe("Acme");
      expect(run.queued()).toHaveLength(1);
      expect(run.queued()[0]).toMatchObject({
        visitId: fresh.id,
        previousTaskId: reproduceTask,
        message: "try again",
      });
      const late = run.succeedTask(failingTestTask, { testPath: "x" });
      expect(late.ignored?.message).toContain("superseded");
    },
  );

  test.concurrent(
    "rerunning the start visit resolves start args from the current work item",
    () => {
      const run = new RunSimulator(bugPipeline(), bugSteps).start();
      run.state.workItem.fields = {
        ...run.state.workItem.fields,
        "What are the Company Name(s):": "Globex",
      };
      run.rerun(run.open("evaluate").id);
      expect(run.open("evaluate").input["companyNames"]).toBe("Globex");
    },
  );

  test.concurrent(
    "rerunning after the run finished reopens it, and gives maxRuns a fresh allowance",
    () => {
      const run = new RunSimulator(bugPipeline(), bugSteps).start();
      run.succeed("evaluate", evaluation);
      run.succeed("reproduce-from-logs", inconclusive);
      expect(run.state.run.status).toBe("failed");
      run.rerun(run.visits("evaluate")[0]?.id as string);
      expect(run.state.run).toMatchObject({
        status: "active",
        endNodeId: null,
        error: null,
        completedAt: null,
      });
      expect(run.trail()).toEqual([
        "evaluate:superseded",
        "reproduce-from-logs:superseded",
        "not-reproduced:superseded",
        "evaluate:active",
      ]);
    },
  );

  test.concurrent(
    "rejects reruns of unknown, superseded and terminal visits",
    () => {
      const run = new RunSimulator(bugPipeline(), bugSteps).start();
      const first = run.open("evaluate").id;
      run.rerun(first);
      expect(() => run.rerun(first)).toThrow(DecideError);
      expect(() => run.rerun("nope")).toThrow(DecideError);
      run.succeed("evaluate", evaluation);
      run.succeed("reproduce-from-logs", inconclusive);
      const terminal = run.visits("not-reproduced")[0]?.id as string;
      expect(() => run.rerun(terminal)).toThrow(DecideError);
    },
  );
});

describe("decide: reruns and lanes", () => {
  test.concurrent(
    "rerun before the merge, while other lanes run, only touches that lane",
    () => {
      const run = itemsRun(["a", "b", "c"]);
      finishLane(run, 0);
      const laneOneTask = run.latestTaskId(run.open("edit-file", 1).id);
      const laneTwoEdit = run.open("edit-file", 2);
      run.rerun(laneTwoEdit.id);
      expect(run.cancelledTasks()).toEqual([run.latestTaskId(laneTwoEdit.id)]);
      expect(run.laneStatuses()).toEqual(["arrived", "active", "active"]);
      expect(run.open("edit-file", 2).input).toEqual({
        file: "c",
        planSummary: "s",
      });
      expect(run.task(laneOneTask).status).toBe("queued");
      finishLane(run, 1);
      finishLane(run, 2);
      expect(run.open("approve-reviews").input["reviews"]).toHaveLength(3);
    },
  );

  test.concurrent(
    "rerun inside a merged group reopens it, clears that lane's arrival, and the merge fires again with the new result",
    () => {
      const run = itemsRun();
      finishLane(run, 0, 0.1);
      finishLane(run, 1);
      const firstMerge = run.open("approve-reviews");
      run.decide("approve-reviews", "approve");
      const openPrTask = run.latestTaskId(run.open("open-pr").id);
      const review = run.visits("review-edit", { item: 0 })[0];
      run.rerun(review?.id as string);
      expect(run.visits("approve-reviews")[0]?.status).toBe("superseded");
      expect(run.visits("open-pr")[0]?.status).toBe("superseded");
      expect(run.cancelledTasks()).toEqual([openPrTask]);
      expect(run.state.laneGroups[0]?.status).toBe("open");
      expect(run.laneStatuses()).toEqual(["active", "arrived"]);
      expect(run.state.lanes[0]).toMatchObject({
        arrivedAtNodeId: null,
        arrivalArgs: null,
        mergedIntoVisitId: null,
      });
      expect(run.state.lanes[1]?.arrivedAtNodeId).toBe("approve-reviews");
      expect(run.open("review-edit", 0).input).toEqual({
        path: "p0",
        diff: "+",
      });
      run.succeed(
        "review-edit",
        { approved: true, confidence: 0.5 },
        { item: 0 },
      );
      const secondMerge = run.open("approve-reviews");
      expect(secondMerge.id).not.toBe(firstMerge.id);
      expect(secondMerge.input["reviews"]).toEqual([
        { approved: true, confidence: 0.5 },
        { approved: true, confidence: 0.9 },
      ]);
      expect(run.state.laneGroups[0]?.status).toBe("merged");
      expect(run.state.lanes.map((lane) => lane.mergedIntoVisitId)).toEqual([
        secondMerge.id,
        secondMerge.id,
      ]);
    },
  );

  test.concurrent(
    "rerunning the merge visit itself recombines the stored arrivals",
    () => {
      const run = itemsRun();
      finishLane(run, 0);
      finishLane(run, 1);
      run.rerun(run.open("approve-reviews").id);
      expect(run.trail().slice(-2)).toEqual([
        "approve-reviews:superseded",
        "approve-reviews:waiting",
      ]);
      const merge = run.open("approve-reviews");
      expect(merge).toMatchObject({
        fromLaneGroupId: run.state.laneGroups[0]?.id,
        transition: { kind: "merge", index: 0 },
      });
      expect(merge.input["reviews"]).toHaveLength(2);
      expect(run.state.laneGroups[0]?.status).toBe("merged");
      expect(run.state.lanes.map((lane) => lane.mergedIntoVisitId)).toEqual([
        merge.id,
        merge.id,
      ]);
    },
  );

  test.concurrent(
    "rerunning the spawning visit supersedes all lanes and cancels them",
    () => {
      const run = itemsRun(["a", "b"]);
      finishLane(run, 0);
      run.rerun(run.visits("plan-changes")[0]?.id as string);
      expect(run.laneStatuses()).toEqual(["arrived", "cancelled"]);
      expect(run.trail().filter((entry) => entry.endsWith(":active"))).toEqual([
        "plan-changes:active",
      ]);
      run.succeed("plan-changes", { files: ["z"], summary: "t" });
      expect(run.state.laneGroups).toHaveLength(2);
      expect(run.open("edit-file", 0).input["file"]).toBe("z");
    },
  );
});
