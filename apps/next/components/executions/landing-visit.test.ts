import { describe, expect, test } from "bun:test";
import {
  buildVisit,
  buildVisitTask,
} from "./execution-detail-view.test-helpers";
import { landingVisit, placesAtOnce, stepsSoFar } from "./landing-visit";

const id = (suffix: string) =>
  `019e9a92-b432-73e8-9341-${suffix.padStart(12, "0")}`;
const at = (second: number) =>
  `2026-06-05T12:00:${String(second).padStart(2, "0")}.000Z`;

const review = buildVisit({ id: id("1"), nodeId: "review", createdAt: at(1) });
const reviewRunning = buildVisit({
  id: id("2"),
  nodeId: "review",
  status: "active",
  createdAt: at(2),
  tasks: [buildVisitTask({ taskId: id("a2"), status: "running" })],
});
const approveWaiting = buildVisit({
  id: id("3"),
  nodeId: "approve",
  nodeKind: "wait",
  status: "waiting",
  fromVisitId: review.id,
  createdAt: at(3),
});
const fixCrashed = buildVisit({
  id: id("4"),
  nodeId: "fix",
  status: "failed",
  fromVisitId: review.id,
  createdAt: at(4),
});
const done = buildVisit({
  id: id("5"),
  nodeId: "done",
  nodeKind: "succeed",
  fromVisitId: review.id,
  createdAt: at(5),
});
const queued = buildVisit({
  id: id("6"),
  nodeId: "review",
  status: "active",
  createdAt: at(6),
  tasks: [buildVisitTask({ taskId: id("a6"), status: "queued" })],
});

const run = (...visits: ReturnType<typeof buildVisit>[]) => ({ visits });

describe("landingVisit", () => {
  test("lands on what's waiting before anything running", () => {
    expect(landingVisit(run(reviewRunning, approveWaiting))?.id).toBe(
      approveWaiting.id,
    );
  });

  test("else on what's running", () => {
    expect(landingVisit(run(review, reviewRunning, queued))?.id).toBe(
      reviewRunning.id,
    );
  });

  test("else on the crashed step, even after a later visit", () => {
    expect(landingVisit(run(review, fixCrashed, queued))?.id).toBe(
      fixCrashed.id,
    );
  });

  test("a failed step that routed on (catch) is not a crash", () => {
    const caught = buildVisit({
      id: id("7"),
      nodeId: "handle",
      fromVisitId: fixCrashed.id,
      createdAt: at(7),
    });
    expect(landingVisit(run(review, fixCrashed, caught))?.id).toBe(caught.id);
  });

  test("else on the end the run reached", () => {
    const after = buildVisit({ id: id("8"), nodeId: "x", createdAt: at(8) });
    expect(landingVisit(run(review, done, after))?.id).toBe(done.id);
  });

  test("a designed fail end counts as the end, not a crash", () => {
    const failEnd = buildVisit({
      id: id("9"),
      nodeId: "rejected",
      nodeKind: "fail",
      status: "failed",
      createdAt: at(9),
    });
    expect(landingVisit(run(review, failEnd))?.id).toBe(failEnd.id);
  });

  test("else on the last live visit, oldest-first by creation", () => {
    expect(landingVisit(run(queued, review))?.id).toBe(queued.id);
  });

  test("skips superseded visits, falling back to them only when nothing else is left", () => {
    const superseded = { ...reviewRunning, status: "superseded" as const };
    expect(landingVisit(run(superseded, review))?.id).toBe(review.id);
    expect(landingVisit(run(superseded))?.id).toBe(superseded.id);
  });

  test("is null for a run with no visits", () => {
    expect(landingVisit(run())).toBeNull();
  });
});

describe("run shape", () => {
  test("steps so far leaves out superseded visits", () => {
    const superseded = { ...review, status: "superseded" as const };
    expect(stepsSoFar(run(superseded, reviewRunning, approveWaiting))).toBe(2);
  });

  test("places at once counts active and waiting visits", () => {
    expect(
      placesAtOnce(run(review, reviewRunning, approveWaiting, queued)),
    ).toBe(3);
  });
});
