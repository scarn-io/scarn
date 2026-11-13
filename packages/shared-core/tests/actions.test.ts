import { describe, expect, test } from "bun:test";
import {
  ActionError,
  actionErrorKind,
  unwrapAction,
} from "../src/lib/action-error";
import type { RunVisit, RunWithVisits } from "../src/lib/run-api-types";
import { planRerun } from "../src/run-actions";

const visit = (
  id: string,
  nodeId: string,
  status: string,
  createdAt: string,
  nodeKind: RunVisit["nodeKind"] = "step",
): RunVisit => ({
  id,
  nodeId,
  nodeKind,
  status,
  tasks: [],
  createdAt,
  completedAt: null,
});

const run: RunWithVisits = {
  id: "run-1",
  workItemId: "wi-1",
  workItemTitle: "Fix login",
  pipelineDefinitionId: "pd-1",
  status: "failed",
  visits: [
    visit("b2", "build", "failed", "2026-01-02"),
    visit("b1", "build", "superseded", "2026-01-01"),
    visit("f1", "end", "failed", "2026-01-03", "fail"),
    visit("t1", "test", "succeeded", "2026-01-04"),
  ],
};

describe("actionErrorKind", () => {
  test("maps HTTP statuses to action kinds", () => {
    expect(
      [404, 401, 403, 409, 400, 422, 500].map((status) =>
        actionErrorKind(status),
      ),
    ).toEqual([
      "not_found",
      "forbidden",
      "forbidden",
      "conflict",
      "rejected",
      "rejected",
      "failed",
    ]);
  });

  test("unwrapAction throws the API's detail under what was attempted", () => {
    expect(() => {
      unwrapAction<string>("cancel Task t", {
        data: undefined,
        error: { status: 422, detail: "Already ended." },
      });
    }).toThrow(
      new ActionError("rejected", "Could not cancel Task t: Already ended."),
    );
  });
});

describe("planRerun", () => {
  test("--step resolves the attempt like runs thread", () => {
    expect(
      planRerun(run, { kind: "step", stepKey: "build", attempt: 1 }).map(
        (target) => [target.visit.id, target.attemptNumber],
      ),
    ).toEqual([["b1", 1]]);
  });

  test("--failed picks failed step visits only, with their attempt numbers", () => {
    expect(
      planRerun(run, { kind: "failed" }).map((target) => [
        target.stepKey,
        target.attemptNumber,
      ]),
    ).toEqual([["build", 2]]);
  });

  test("--failed with nothing failed is rejected", () => {
    const passing = { ...run, visits: [visit("t1", "test", "succeeded", "x")] };
    expect(() => planRerun(passing, { kind: "failed" })).toThrow(
      "Pipeline run run-1 has no failed steps to rerun.",
    );
  });
});
