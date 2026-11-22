import { describe, expect, test } from "bun:test";
import { RunSimulator } from "./engine-harness";
import {
  bugPipeline,
  bugSteps,
  clone,
  decisionPipeline,
  decisionSteps,
} from "./engine-fixtures";

const plan = { summary: "Guard the null cart" };

function toReview(document: object = decisionPipeline()) {
  const run = new RunSimulator(document, decisionSteps).start();
  run.succeed("propose-fix", plan);
  return run;
}

function revise(run: RunSimulator, feedback: string) {
  run.decide("review-fix", "revise", feedback);
  run.succeed("propose-fix", { summary: `after: ${feedback}` });
}

describe("decide: decision waits", () => {
  test.concurrent("entering a decision wait parks the run", () => {
    const run = toReview();
    expect(run.open("review-fix")).toMatchObject({
      status: "waiting",
      input: { plan },
    });
    expect(run.state.run.status).toBe("waiting");
  });

  test.concurrent(
    "approve routes to apply-fix with the reached-back plan",
    () => {
      const run = toReview();
      const result = run.decide("review-fix", "approve", "Ship it");
      expect(result.ignored).toBeUndefined();
      expect(run.visits("review-fix")[0]).toMatchObject({
        status: "succeeded",
        result: { action: "approve", body: "Ship it" },
        resolvedByUserId: "reviewer",
      });
      expect(run.visits("review-fix")[0]?.resolvedAt).not.toBeNull();
      expect(run.visits("review-fix")[0]?.completedAt).not.toBeNull();
      expect(run.open("apply-fix").input).toEqual({ plan });
      expect(run.state.run.status).toBe("active");
    },
  );

  test.concurrent("reject takes the otherwise branch", () => {
    const run = toReview();
    run.decide("review-fix", "reject");
    expect(run.state.run).toMatchObject({
      status: "failed",
      endNodeId: "rejected",
      error: { name: "FixRejected" },
    });
  });

  test.concurrent(
    "revise re-enters propose-fix with the feedback, then reviews again",
    () => {
      const run = toReview();
      const first = run.open("review-fix").id;
      run.decide("review-fix", "revise", "Handle the empty cart too");
      expect(run.open("propose-fix").input).toEqual({
        title: "Checkout crashes",
        feedback: "Handle the empty cart too",
      });
      run.succeed("propose-fix", { summary: "v2" });
      const second = run.open("review-fix");
      expect(second.id).not.toBe(first);
      expect(second.input).toEqual({ plan: { summary: "v2" } });
      expect(run.trail()).toEqual([
        "propose-fix:succeeded",
        "review-fix:succeeded",
        "propose-fix:succeeded",
        "review-fix:waiting",
      ]);
    },
  );

  test.concurrent("revise loops have no default limit", () => {
    const run = toReview();
    revise(run, "one");
    revise(run, "two");
    revise(run, "three");
    expect(run.visits("review-fix", { status: "succeeded" })).toHaveLength(3);
    expect(run.open("review-fix").input).toEqual({
      plan: { summary: "after: three" },
    });
    run.decide("review-fix", "approve");
    expect(run.open("apply-fix").input).toEqual({
      plan: { summary: "after: three" },
    });
  });

  test.concurrent("maxRuns caps the loop and a catch routes it", () => {
    const document = clone(decisionPipeline());
    Object.assign(document.nodes["review-fix"] as object, {
      maxRuns: 2,
      catch: [{ on: ["Scarn.MaxRunsExceeded"], to: "too-many-revisions" }],
    });
    document.nodes["too-many-revisions"] = {
      kind: "fail",
      error: "TooManyRevisions",
    };
    const run = toReview(document);
    revise(run, "one");
    revise(run, "two");
    expect(run.visits("review-fix").at(-1)).toMatchObject({
      status: "failed",
      error: { name: "Scarn.MaxRunsExceeded" },
    });
    expect(run.state.run).toMatchObject({
      status: "failed",
      endNodeId: "too-many-revisions",
      error: { name: "TooManyRevisions" },
    });
  });

  test.concurrent("an unknown action is ignored as invalid", () => {
    const run = toReview();
    const result = run.decide("review-fix", "merge");
    expect(result.commands).toEqual([]);
    expect(result.ignored).toEqual({
      kind: "invalid_decision",
      message: 'unknown action "merge"',
    });
    expect(run.open("review-fix").status).toBe("waiting");
  });

  test.concurrent("revise without a body is ignored as invalid", () => {
    const run = toReview();
    const result = run.decide("review-fix", "revise", null);
    expect(result.commands).toEqual([]);
    expect(result.ignored).toEqual({
      kind: "invalid_decision",
      message: 'action "revise" needs a body',
    });
    expect(run.open("review-fix").status).toBe("waiting");
  });

  test.concurrent("an optional action without a body succeeds", () => {
    const run = toReview();
    const result = run.decide("review-fix", "approve", null);
    expect(result.ignored).toBeUndefined();
    expect(run.visits("review-fix")[0]?.result).toEqual({
      action: "approve",
      body: null,
    });
  });

  test.concurrent("a decision on a visit that isn't waiting is ignored", () => {
    const run = toReview();
    const visitId = run.open("review-fix").id;
    run.decide("review-fix", "approve");
    const again = run.send({
      type: "decision_made",
      visitId,
      action: "reject",
      body: null,
      userId: "reviewer",
    });
    expect(again.commands).toEqual([]);
    expect(again.ignored?.kind).toBe("not_waiting");
    expect(run.open("apply-fix").status).toBe("active");
  });

  test.concurrent("decision_made on a reply wait is ignored", () => {
    const run = new RunSimulator(bugPipeline(), bugSteps).start();
    run.succeed("evaluate", {
      quality: 0.01,
      hasRumSession: false,
      maxAttempts: 3,
      summary: "vague",
      missingDetails: ["Which browser?"],
    });
    const result = run.decide("ask-for-details", "approve");
    expect(result.commands).toEqual([]);
    expect(result.ignored?.kind).toBe("not_waiting");
    expect(run.open("ask-for-details").status).toBe("waiting");
  });
});
