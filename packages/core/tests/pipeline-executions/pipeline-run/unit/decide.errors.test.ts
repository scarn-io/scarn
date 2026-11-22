import { describe, expect, test } from "bun:test";
import { RunSimulator } from "./engine-harness";
import { bugPipeline, bugSteps, clone } from "./engine-fixtures";

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

function toFix(document: object = bugPipeline()) {
  const run = new RunSimulator(document, bugSteps).start();
  run.succeed("evaluate", evaluation);
  run.succeed("reproduce-from-logs", reproduced);
  run.succeed("failing-test", { testPath: "a.test.ts" });
  run.succeed("propose-fix", { requiresHumanApproval: false });
  return run;
}

describe("decide: catch and retry", () => {
  test.concurrent(
    "catch with Scarn.All routes a failed step to its target",
    () => {
      const run = new RunSimulator(bugPipeline(), bugSteps).start();
      run.succeed("evaluate", evaluation);
      run.fail("reproduce-from-logs", {
        name: "LogsUnavailable",
        message: "no logs",
      });
      expect(run.trail()).toEqual([
        "evaluate:succeeded",
        "reproduce-from-logs:failed",
        "not-reproduced:failed",
      ]);
      expect(run.visits("reproduce-from-logs")[0]?.error).toEqual({
        name: "LogsUnavailable",
        message: "no logs",
      });
      expect(run.state.run).toMatchObject({
        status: "failed",
        endNodeId: "not-reproduced",
      });
    },
  );

  test.concurrent(
    "an unnamed failure is Scarn.StepFailed, and uncaught it fails the run",
    () => {
      const run = new RunSimulator(bugPipeline(), bugSteps).start();
      run.fail("evaluate");
      expect(run.state.run).toMatchObject({
        status: "failed",
        endNodeId: null,
        error: { name: "Scarn.StepFailed", message: "boom" },
      });
    },
  );

  test.concurrent(
    "the Task retries a matching failure on the same visit, out of the engine's sight, until maxAttempts",
    () => {
      const run = toFix();
      const fix = run.open("fix");
      run.abandon("fix");
      expect(run.last.commands).toEqual([]);
      expect(run.retried).toHaveLength(1);
      expect(run.retried[0]).toMatchObject({
        visitId: fix.id,
        attemptNumber: 2,
      });
      expect(run.open("fix").id).toBe(fix.id);
      run.abandon("fix");
      expect(run.retried[0]?.attemptNumber).toBe(3);
      run.abandon("fix");
      expect(run.retried).toEqual([]);
      expect(run.queued()).toEqual([]);
      expect(run.visits("fix")[0]).toMatchObject({
        status: "failed",
        error: { name: "Scarn.HeartbeatTimeout" },
      });
      expect(run.state.run.status).toBe("failed");
    },
  );

  test.concurrent(
    "retry only applies to matching errors; timeouts are Scarn.Timeout",
    () => {
      const run = toFix();
      const taskId = run.latestTaskId(run.open("fix").id);
      run.send({
        type: "task_failed",
        ...run.taskIds(taskId),
        error: { name: "Scarn.Timeout", message: "The step timed out" },
      });
      expect(run.queued()).toEqual([]);
      expect(run.state.run.error).toEqual({
        name: "Scarn.Timeout",
        message: "The step timed out",
      });
    },
  );

  test.concurrent("catch is tried once retries are used up", () => {
    const document = clone(bugPipeline());
    document.nodes["fix"] = {
      ...document.nodes["fix"],
      retry: [{ on: ["Scarn.All"], maxAttempts: 1 }],
      catch: [{ on: ["Scarn.All"], to: "fix-rejected" }],
    };
    const run = toFix(document);
    run.fail("fix", { name: "MergeConflict" });
    expect(run.retried).toHaveLength(1);
    run.fail("fix", { name: "MergeConflict" });
    expect(run.retried).toEqual([]);
    expect(run.trail().slice(-2)).toEqual([
      "fix:failed",
      "fix-rejected:failed",
    ]);
  });

  test.concurrent("a result from an earlier attempt is ignored", () => {
    const run = toFix();
    const first = run.latestTaskId(run.open("fix").id);
    run.abandon("fix");
    const late = run.succeedTask(first, { testsPass: true });
    expect(late.ignored?.message).toContain("latest attempt");
    expect(late.commands).toEqual([]);
  });

  test.concurrent("a ConditionError from a when goes through catch", () => {
    const document = clone(bugPipeline());
    const logs = document.nodes["reproduce-from-logs"] as {
      next: { routes: { when?: unknown }[] };
    };
    (logs.next.routes[0] as { when: unknown }).when = {
      avg: ["result.reproductionConfidence"],
      op: "greaterThan",
      value: 0.5,
    };
    const run = new RunSimulator(document, bugSteps).start();
    run.succeed("evaluate", evaluation);
    run.succeed("reproduce-from-logs", { evidenceVerdict: "reproduced" });
    const logsVisit = run.visits("reproduce-from-logs")[0];
    expect(logsVisit).toMatchObject({
      status: "failed",
      error: { name: "Scarn.ConditionError" },
      routing: { checked: [], taken: null },
    });
    expect(run.state.run.endNodeId).toBe("not-reproduced");
  });
});

describe("decide: decisions", () => {
  function toDecision() {
    const run = new RunSimulator(bugPipeline(), bugSteps).start();
    run.succeed("evaluate", evaluation);
    run.succeed("reproduce-from-logs", reproduced);
    run.succeed("failing-test", { testPath: "a.test.ts" });
    run.succeed("propose-fix", { requiresHumanApproval: true, summary: "p" });
    return run;
  }

  test.concurrent("a wait visit makes the run waiting", () => {
    const run = toDecision();
    const wait = run.open("approve-fix");
    expect(wait).toMatchObject({ status: "waiting", nodeKind: "wait" });
    expect(wait.input).toEqual({
      request: { requiresHumanApproval: true, summary: "p" },
    });
    expect(run.queued()).toEqual([]);
    expect(run.state.run.status).toBe("waiting");
  });

  test.concurrent(
    "approving stores the result and continues with reach-back args",
    () => {
      const run = toDecision();
      run.decide("approve-fix", "approve", "go");
      expect(run.visits("approve-fix")[0]).toMatchObject({
        status: "succeeded",
        result: { action: "approve", body: "go" },
        resolvedByUserId: "reviewer",
      });
      expect(run.open("fix").input).toMatchObject({
        plan: { requiresHumanApproval: true, summary: "p" },
        failingTest: { testPath: "a.test.ts" },
      });
      expect(run.state.run.status).toBe("active");
    },
  );

  test.concurrent("rejecting takes the otherwise branch", () => {
    const run = toDecision();
    run.decide("approve-fix", "reject", "no");
    expect(run.state.run).toMatchObject({
      status: "failed",
      endNodeId: "fix-rejected",
      error: { name: "FixRejected" },
    });
  });

  test.concurrent("deciding twice is ignored", () => {
    const run = toDecision();
    const visitId = run.open("approve-fix").id;
    run.decide("approve-fix", "reject");
    const again = run.send({
      type: "decision_made",
      visitId,
      action: "approve",
      body: null,
      userId: "x",
    });
    expect(again.commands).toEqual([]);
    expect(again.ignored).toBeDefined();
  });
});
