import { describe, expect, test } from "bun:test";
import { DecideError } from "@/pipeline-executions/pipeline-run/domain/engine/types";
import { RunSimulator } from "./engine-harness";
import { bugPipeline, bugSteps, clone } from "./engine-fixtures";

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
const plan = { requiresHumanApproval: false, summary: "patch" };

function bugRun(document: object = bugPipeline()) {
  return new RunSimulator(document, bugSteps).start();
}

function throughFailingTest(run: RunSimulator) {
  run.succeed("evaluate", evaluation);
  run.succeed("reproduce-from-logs", reproduced, { workBranch: "repro" });
  run.succeed("failing-test", { testPath: "a.test.ts" }, { workBranch: "t" });
  return run;
}

describe("decide: bug pipeline", () => {
  test.concurrent(
    "start resolves work-item args and queues the first Task",
    () => {
      const run = bugRun();
      expect(run.trail()).toEqual(["evaluate:active"]);
      expect(run.queued()).toEqual([
        {
          id: "id-2",
          taskId: "id-3",
          visitId: "id-1",
          attemptNumber: 1,
          stepKey: "evaluate",
          input: { companyNames: "Acme", employeeEmails: "ana@example.com" },
          previousTaskId: null,
          baseBranch: null,
          executionTimeoutSeconds: null,
          heartbeatSeconds: null,
          message: null,
          reason: "initial",
        },
      ]);
      expect(run.state.run.status).toBe("active");
      expect(() => run.send({ type: "start" })).toThrow(DecideError);
    },
  );

  test.concurrent(
    "takes the first matching branch and records the checks",
    () => {
      const run = bugRun();
      run.succeed("evaluate", { ...evaluation, hasRumSession: true });
      const evaluate = run.visits("evaluate")[0];
      expect(evaluate?.status).toBe("succeeded");
      expect(evaluate?.resultTaskId).toBe("id-2");
      expect(evaluate?.routing).toEqual({
        checked: [
          {
            index: 0,
            matched: false,
            when: {
              kind: "compare",
              result: false,
              left: { path: "result.quality", value: 0.9 },
              op: "lessThan",
              right: { value: 0.1 },
            },
          },
          {
            index: 1,
            matched: true,
            when: {
              kind: "compare",
              result: true,
              left: { path: "result.hasRumSession", value: true },
              op: "equal",
              right: { value: true },
            },
          },
        ],
        taken: [{ kind: "route", index: 1 }],
      });
      const next = run.open("reproduce-from-session");
      expect(next.input).toEqual({
        companyNames: "Acme",
        employeeEmails: "ana@example.com",
        evaluation: { ...evaluation, hasRumSession: true },
      });
      expect(next.transition).toEqual({ kind: "route", index: 1 });
    },
  );

  test.concurrent(
    "runs the happy path to done, reaching back through the chain",
    () => {
      const run = throughFailingTest(bugRun());
      expect(run.open("propose-fix").input).toEqual({
        evaluation,
        investigation: reproduced,
        failingTest: { testPath: "a.test.ts" },
      });
      run.succeed("propose-fix", plan);
      const fix = run.open("fix");
      expect(fix.input).toEqual({
        evaluation,
        investigation: reproduced,
        failingTest: { testPath: "a.test.ts" },
        plan,
      });
      expect(run.queued()[0]).toMatchObject({
        stepKey: "fix",
        baseBranch: "t",
        executionTimeoutSeconds: 3600,
        heartbeatSeconds: 300,
      });
      run.succeed(
        "fix",
        { testsPass: false, attempts: 1 },
        { workBranch: "f1" },
      );
      expect(run.open("fix").input["previousAttempt"]).toEqual({
        testsPass: false,
        attempts: 1,
      });
      expect(run.queued()[0]?.baseBranch).toBe("f1");
      run.succeed("fix", { testsPass: true, attempts: 2 });
      expect(run.trail().slice(-3)).toEqual([
        "fix:succeeded",
        "fix:succeeded",
        "done:succeeded",
      ]);
      expect(run.state.run).toMatchObject({
        status: "succeeded",
        endNodeId: "done",
      });
    },
  );

  test.concurrent("a fail node fails the run with its error", () => {
    const run = bugRun();
    run.succeed("evaluate", evaluation);
    run.succeed("reproduce-from-logs", {
      reproductionConfidence: 0.2,
      evidenceVerdict: "inconclusive",
    });
    expect(run.state.run).toMatchObject({
      status: "failed",
      endNodeId: "not-reproduced",
      error: { name: "NotReproduced" },
    });
  });

  test.concurrent(
    "maxRuns raises Scarn.MaxRunsExceeded, which fails the run uncaught",
    () => {
      const run = throughFailingTest(bugRun());
      run.succeed("propose-fix", plan);
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        run.succeed("fix", { testsPass: false, attempts: attempt });
      }
      const last = run.visits("fix").at(-1);
      expect(run.visits("fix")).toHaveLength(6);
      expect(last?.status).toBe("failed");
      expect(last?.error?.name).toBe("Scarn.MaxRunsExceeded");
      expect(
        run.state.visitTasks.filter((link) => link.visitId === last?.id),
      ).toEqual([]);
      expect(run.state.run.status).toBe("failed");
      expect(run.state.run.error?.name).toBe("Scarn.MaxRunsExceeded");
    },
  );

  test.concurrent("Scarn.MaxRunsExceeded can be caught", () => {
    const document = clone(bugPipeline());
    document.nodes["fix"] = {
      ...document.nodes["fix"],
      maxRuns: 1,
      catch: [{ on: ["Scarn.MaxRunsExceeded"], to: "fix-rejected" }],
    };
    const run = throughFailingTest(bugRun(document));
    run.succeed("propose-fix", plan);
    run.succeed("fix", { testsPass: false });
    expect(run.trail().slice(-3)).toEqual([
      "fix:succeeded",
      "fix:failed",
      "fix-rejected:failed",
    ]);
    expect(run.visits("fix-rejected")[0]?.transition).toEqual({
      kind: "catch",
      index: 0,
    });
    expect(run.state.run.endNodeId).toBe("fix-rejected");
  });

  test.concurrent(
    "cancel cancels open Tasks and visits, then ignores late results",
    () => {
      const run = bugRun();
      const taskId = run.latestTaskId(run.open("evaluate").id);
      run.send({ type: "cancel", userId: "admin" });
      expect(run.cancelledTasks()).toEqual([taskId]);
      expect(run.trail()).toEqual(["evaluate:cancelled"]);
      expect(run.state.run).toMatchObject({
        status: "cancelled",
        cancelledByUserId: "admin",
      });
      const late = run.succeedTask(taskId, evaluation);
      expect(late.commands).toEqual([]);
      expect(late.ignored?.message).toContain("cancelled");
    },
  );
});
