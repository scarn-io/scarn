import { describe, expect, test } from "bun:test";
import type { JsonObject } from "@scarn/sdk/contracts/pipeline-document";
import { RunSimulator } from "./engine-harness";
import type { Doc } from "./engine-fixtures";
import type { Json } from "./engine-fixtures-overrule";
import {
  reproductionPipeline,
  reproductionSteps,
  nextOf,
  refusal,
} from "./engine-fixtures-overrule";

const evaluation = {
  quality: 0.9,
  hasRumSession: false,
  maxAttempts: 3,
  summary: "crash",
  missingDetails: [],
};
const borderline = {
  reproductionConfidence: 0.78,
  evidenceVerdict: "reproduced",
};
const confident = {
  reproductionConfidence: 0.9,
  evidenceVerdict: "reproduced",
};
const REPRODUCED = { kind: "route", index: 0 } as const;
const NOT_REPRODUCED = { kind: "otherwise", index: 0 } as const;

/** Runs the bug pipeline up to `report-reproduction` succeeding with `report`. */
function reportedRun(
  investigation: JsonObject,
  report: JsonObject = { summary: "s", notes: "trace is clear" },
  document: Doc = reproductionPipeline(),
) {
  const run = new RunSimulator(document, reproductionSteps).start();
  run.succeed("evaluate", evaluation);
  run.succeed("reproduce-from-logs", investigation);
  run.succeed("report-reproduction", report);
  const visit = run.visits("report-reproduction")[0];
  return { run, visitId: visit?.id as string };
}

describe("decide: overruling a route on match first", () => {
  test.concurrent(
    "a run failed at not-reproduced carries on to failing-test",
    () => {
      const { run, visitId } = reportedRun(borderline);
      expect(run.state.run).toMatchObject({
        status: "failed",
        endNodeId: "not-reproduced",
      });
      run.overrule(visitId, [REPRODUCED], { reason: "the trace is clear" });
      expect(run.trail()).toEqual([
        "evaluate:succeeded",
        "reproduce-from-logs:succeeded",
        "report-reproduction:succeeded",
        "not-reproduced:superseded",
        "failing-test:active",
      ]);
      expect(run.state.run).toMatchObject({
        status: "active",
        endNodeId: null,
        error: null,
        completedAt: null,
      });
      expect(run.queued().map((task) => [task.stepKey, task.input])).toEqual([
        [
          "failing-test",
          { evaluation, investigation: borderline, notes: "trace is clear" },
        ],
      ]);
      expect(run.open("failing-test").fromVisitId).toBe(visitId);
      const overruled = run.visits("report-reproduction")[0];
      expect(run.task(run.latestTaskId(visitId)).result).toEqual({
        summary: "s",
        notes: "trace is clear",
      });
      expect(overruled?.routing).toMatchObject({
        checked: [{ index: 0, matched: false }],
        taken: [REPRODUCED],
        overrules: [
          {
            from: [NOT_REPRODUCED],
            to: [REPRODUCED],
            byUserId: "overruler",
            reason: "the trace is clear",
            missingArgs: [],
          },
        ],
      });
      expect(overruled?.routing?.overrules?.[0]?.at).toMatch(/^2026-/);
    },
  );

  test.concurrent(
    "mid-run: the running downstream step is cancelled and superseded",
    () => {
      const { run, visitId } = reportedRun(confident);
      const failingTestTask = run.latestTaskId(run.open("failing-test").id);
      run.overrule(visitId, [NOT_REPRODUCED]);
      expect(run.cancelledTasks()).toEqual([failingTestTask]);
      expect(run.trail()).toEqual([
        "evaluate:succeeded",
        "reproduce-from-logs:succeeded",
        "report-reproduction:succeeded",
        "failing-test:superseded",
        "not-reproduced:failed",
      ]);
      expect(run.state.run).toMatchObject({
        status: "failed",
        endNodeId: "not-reproduced",
      });
    },
  );

  test.concurrent(
    "overruling twice records both, and a rerun afterwards starts clean",
    () => {
      const { run, visitId } = reportedRun(borderline);
      run.overrule(visitId, [REPRODUCED]);
      run.overrule(visitId, [NOT_REPRODUCED], { reason: "changed my mind" });
      const overrules = run.visits("report-reproduction")[0]?.routing
        ?.overrules;
      expect(overrules?.map(({ from, to }) => [from, to])).toEqual([
        [[NOT_REPRODUCED], [REPRODUCED]],
        [[REPRODUCED], [NOT_REPRODUCED]],
      ]);
      expect(run.visits("failing-test")[0]?.status).toBe("superseded");
      expect(run.state.run.status).toBe("failed");
      run.rerun(visitId);
      const fresh = run.open("report-reproduction");
      expect(fresh.id).not.toBe(visitId);
      expect(fresh.routing).toBeNull();
      run.succeed("report-reproduction", { summary: "again" });
      expect(
        run.visits("report-reproduction")[1]?.routing?.overrules,
      ).toBeUndefined();
    },
  );

  test.concurrent("superseded visits don't count toward maxRuns", () => {
    const document = reproductionPipeline();
    (document.nodes["failing-test"] as Json)["maxRuns"] = 1;
    const { run, visitId } = reportedRun(confident, undefined, document);
    run.overrule(visitId, [NOT_REPRODUCED]);
    run.overrule(visitId, [REPRODUCED]);
    expect(run.open("failing-test").status).toBe("active");
    expect(run.state.run.status).toBe("active");
  });
});

describe("decide: which routes can be overruled", () => {
  function markedRun(flags: { route?: true; otherwise?: true }) {
    const document = reproductionPipeline();
    const next = nextOf(document, "report-reproduction");
    delete next["overridable"];
    if (flags.route) {
      (next.routes[0] as Json)["overridable"] = true;
    }
    if (flags.otherwise) {
      (next["otherwise"] as Json)["overridable"] = true;
    }
    return reportedRun(borderline, undefined, document);
  }

  test.concurrent("refused when neither route is marked", () => {
    const { run, visitId } = markedRun({});
    const error = refusal(() => run.overrule(visitId, [REPRODUCED]));
    expect(error.code).toBe("route_not_overridable");
    expect(error.meta).toEqual({ routes: [NOT_REPRODUCED, REPRODUCED] });
  });

  test.concurrent("refused when only the chosen route is marked", () => {
    const { run, visitId } = markedRun({ route: true });
    const error = refusal(() => run.overrule(visitId, [REPRODUCED]));
    expect(error.code).toBe("route_not_overridable");
    expect(error.meta).toEqual({ routes: [NOT_REPRODUCED] });
  });

  test.concurrent("refused when only the taken route is marked", () => {
    const { run, visitId } = markedRun({ otherwise: true });
    const error = refusal(() => run.overrule(visitId, [REPRODUCED]));
    expect(error.code).toBe("route_not_overridable");
    expect(error.meta).toEqual({ routes: [REPRODUCED] });
    expect(run.state.run.status).toBe("failed");
  });

  test.concurrent("allowed through each route's own flag", () => {
    const { run, visitId } = markedRun({ route: true, otherwise: true });
    run.overrule(visitId, [REPRODUCED]);
    expect(run.open("failing-test").status).toBe("active");
  });

  test.concurrent("allowed through next.overridable", () => {
    const { run, visitId } = reportedRun(borderline);
    run.overrule(visitId, [REPRODUCED]);
    expect(run.open("failing-test").status).toBe("active");
  });

  test.concurrent(
    "from a path that ended, only the chosen route needs the flag; the finished run reopens",
    () => {
      const document = reproductionPipeline();
      const next = nextOf(document, "report-reproduction");
      delete next["overridable"];
      delete next["otherwise"];
      (next.routes[0] as Json)["overridable"] = true;
      const { run, visitId } = reportedRun(borderline, undefined, document);
      expect(run.state.run).toMatchObject({
        status: "succeeded",
        endNodeId: "report-reproduction",
      });
      run.overrule(visitId, [REPRODUCED]);
      expect(run.state.run).toMatchObject({
        status: "active",
        endNodeId: null,
      });
      expect(run.open("failing-test").status).toBe("active");
      expect(
        run.visits("report-reproduction")[0]?.routing?.overrules?.[0]?.from,
      ).toEqual([]);
    },
  );
});

describe("decide: overrule refusals", () => {
  test.concurrent("the route already taken", () => {
    const { run, visitId } = reportedRun(borderline);
    expect(refusal(() => run.overrule(visitId, [NOT_REPRODUCED])).code).toBe(
      "route_unchanged",
    );
  });

  test.concurrent("a route the node doesn't have", () => {
    const { run, visitId } = reportedRun(borderline);
    expect(
      refusal(() => run.overrule(visitId, [{ kind: "route", index: 4 }])).code,
    ).toBe("unknown_route");
    expect(
      refusal(() => run.overrule(visitId, [{ kind: "catch", index: 0 }])).code,
    ).toBe("unknown_route");
  });

  test.concurrent("two routes, or none, on a match first node", () => {
    const { run, visitId } = reportedRun(borderline);
    expect(
      refusal(() => run.overrule(visitId, [REPRODUCED, NOT_REPRODUCED])).code,
    ).toBe("route_set_invalid");
    expect(refusal(() => run.overrule(visitId, [])).code).toBe(
      "route_set_invalid",
    );
  });

  test.concurrent("an unknown visit", () => {
    const { run } = reportedRun(borderline);
    expect(refusal(() => run.overrule("nope", [REPRODUCED])).code).toBe(
      "unknown_visit",
    );
  });

  test.concurrent("a visit that isn't a step", () => {
    const { run } = reportedRun(borderline);
    const terminal = run.visits("not-reproduced")[0]?.id as string;
    const error = refusal(() => run.overrule(terminal, [REPRODUCED]));
    expect(error.code).toBe("invalid_visit_state");
    expect(error.message).toBe('only step visits can be overruled, not "fail"');
  });

  test.concurrent("a running or failed visit", () => {
    const run = new RunSimulator(reproductionPipeline(), reproductionSteps);
    run.start();
    run.succeed("evaluate", evaluation);
    run.succeed("reproduce-from-logs", borderline);
    const visitId = run.open("report-reproduction").id;
    expect(refusal(() => run.overrule(visitId, [REPRODUCED])).code).toBe(
      "invalid_visit_state",
    );
    run.fail("report-reproduction");
    expect(refusal(() => run.overrule(visitId, [REPRODUCED])).code).toBe(
      "invalid_visit_state",
    );
  });

  test.concurrent("a superseded visit", () => {
    const { run, visitId } = reportedRun(borderline);
    run.rerun(visitId);
    expect(refusal(() => run.overrule(visitId, [REPRODUCED])).code).toBe(
      "invalid_visit_state",
    );
  });

  test.concurrent("a cancelled run", () => {
    const { run, visitId } = reportedRun(confident);
    run.send({ type: "cancel", userId: "canceller" });
    expect(refusal(() => run.overrule(visitId, [NOT_REPRODUCED])).code).toBe(
      "run_not_active",
    );
  });
});

describe("decide: overrules with missing args", () => {
  const withoutNotes = { summary: "s" };
  const missing = [{ arg: "notes", reference: "result.notes" }];

  test.concurrent("refused with the list of missing args", () => {
    const { run, visitId } = reportedRun(borderline, withoutNotes);
    const error = refusal(() => run.overrule(visitId, [REPRODUCED]));
    expect(error.code).toBe("route_args_missing");
    expect(error.meta).toEqual({ missing });
    expect(run.state.run.status).toBe("failed");
  });

  test.concurrent("accepted: the run carries on without them", () => {
    const { run, visitId } = reportedRun(borderline, withoutNotes);
    run.overrule(visitId, [REPRODUCED], { missingArgs: "accept" });
    expect(run.open("failing-test").input).toEqual({
      evaluation,
      investigation: borderline,
    });
    expect(
      run.visits("report-reproduction")[0]?.routing?.overrules?.[0]
        ?.missingArgs,
    ).toEqual(missing);
  });

  test.concurrent("refused for a code step, with its own message", () => {
    const { run, visitId } = reportedRun(borderline, withoutNotes);
    const error = refusal(() =>
      run.overrule(visitId, [REPRODUCED], { missingArgs: "reject_code_step" }),
    );
    expect(error.code).toBe("route_args_missing");
    expect(error.message).toContain("code step");
    expect(error.meta).toEqual({ missing });
  });
});
