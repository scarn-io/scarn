import { describe, expect, test } from "bun:test";
import { parseUuidV7 } from "@scarn/api/frontend-contracts";
import {
  buildExecutionStepItems,
  resolveSelectedVisit,
} from "./execution-step-items";
import {
  buildRunVersion,
  buildVisit,
  buildVisitTask,
} from "./execution-detail-view.test-helpers";

const REVIEW_VISIT_ID = "019e0000-0000-7000-8000-000000000401";
const RERUN_VISIT_ID = "019e0000-0000-7000-8000-000000000402";
const LANE_ONE_VISIT_ID = "019e0000-0000-7000-8000-000000000403";
const LANE_TWO_VISIT_ID = "019e0000-0000-7000-8000-000000000404";
const ORPHAN_VISIT_ID = "019e0000-0000-7000-8000-000000000405";
const TASK_ID = "019e0000-0000-7000-8000-000000000601";

const reviewVisit = buildVisit({
  id: REVIEW_VISIT_ID,
  nodeId: "review",
  tasks: [buildVisitTask({ taskId: TASK_ID })],
});

describe("buildExecutionStepItems", () => {
  test("lists every document node in order, unvisited ones without a status", () => {
    const items = buildExecutionStepItems({
      execution: { visits: [reviewVisit] },
      version: buildRunVersion(),
    });

    expect(items).toMatchObject([
      {
        nodeId: "review",
        position: 1,
        kind: "step",
        title: "Review",
        stepKey: "review",
        status: "succeeded",
      },
      {
        nodeId: "approve",
        kind: "wait",
        stepKey: null,
        status: null,
        visit: null,
        visits: [],
      },
      { nodeId: "done", kind: "succeed", status: null },
    ]);
  });

  test("keeps visits to nodes the loaded document doesn't know", () => {
    const items = buildExecutionStepItems({
      execution: {
        visits: [
          reviewVisit,
          buildVisit({
            id: ORPHAN_VISIT_ID,
            nodeId: "legacy",
            nodeKind: "fail",
            status: "failed",
          }),
        ],
      },
      version: buildRunVersion(),
    });

    expect(items[3]).toMatchObject({
      nodeId: "legacy",
      position: 4,
      kind: "fail",
      status: "failed",
    });
  });

  test("groups lanes and reruns under one node; the worst current visit wins", () => {
    const superseded = { ...reviewVisit, status: "superseded" as const };
    const laneOne = buildVisit({
      id: LANE_ONE_VISIT_ID,
      nodeId: "review",
      createdAt: "2026-06-05T12:01:00.000Z",
    });
    const laneTwo = buildVisit({
      id: LANE_TWO_VISIT_ID,
      nodeId: "review",
      status: "active",
      tasks: [buildVisitTask({ taskId: TASK_ID, status: "timeout" })],
      createdAt: "2026-06-05T12:02:00.000Z",
    });

    const [review] = buildExecutionStepItems({
      execution: { visits: [laneTwo, superseded, laneOne] },
      version: buildRunVersion(),
    });

    expect(review?.visits.map((visit) => visit.id)).toEqual([
      parseUuidV7(REVIEW_VISIT_ID),
      parseUuidV7(LANE_ONE_VISIT_ID),
      parseUuidV7(LANE_TWO_VISIT_ID),
    ]);
    expect(review?.status).toBe("timeout");
    expect(review?.visit?.id).toBe(parseUuidV7(LANE_TWO_VISIT_ID));
  });
});

describe("resolveSelectedVisit", () => {
  const rerun = buildVisit({
    id: RERUN_VISIT_ID,
    nodeId: "review",
    createdAt: "2026-06-05T12:05:00.000Z",
  });
  const [review] = buildExecutionStepItems({
    execution: {
      visits: [{ ...reviewVisit, status: "superseded" }, rerun],
    },
    version: buildRunVersion(),
  });

  test("defaults to the node's latest current visit", () => {
    expect(resolveSelectedVisit(review ?? null, null)?.id).toBe(
      parseUuidV7(RERUN_VISIT_ID),
    );
  });

  test("picks a named visit of the node, ignoring unknown ids", () => {
    expect(resolveSelectedVisit(review ?? null, REVIEW_VISIT_ID)?.id).toBe(
      parseUuidV7(REVIEW_VISIT_ID),
    );
    expect(resolveSelectedVisit(review ?? null, "nope")?.id).toBe(
      parseUuidV7(RERUN_VISIT_ID),
    );
    expect(resolveSelectedVisit(null, REVIEW_VISIT_ID)).toBeNull();
  });
});
