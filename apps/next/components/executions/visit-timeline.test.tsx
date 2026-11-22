import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import type { NodeVisitContract } from "@scarn/api/frontend-contracts";
import { buildExecutionStepItems } from "./execution-step-items";
import {
  buildLane,
  buildRunExecution,
  buildRunVersion,
  buildVisit,
  buildVisitTask,
} from "./execution-detail-view.test-helpers";
import { VisitTimeline } from "./visit-timeline";
import {
  buildVisitTimeline,
  type VisitTimelineEntry,
} from "./visit-timeline-entries";
import { installDom } from "@/tests/support/install-dom";

const EXECUTION_ID = "019e0000-0000-7000-8000-000000000801";
const REVIEW_OLD_ID = "019e0000-0000-7000-8000-000000000901";
const REVIEW_ID = "019e0000-0000-7000-8000-000000000902";
const APPROVE_ID = "019e0000-0000-7000-8000-000000000903";
const DONE_ID = "019e0000-0000-7000-8000-000000000904";
const LANE_ONE_VISIT_ID = "019e0000-0000-7000-8000-000000000911";
const LANE_TWO_VISIT_ID = "019e0000-0000-7000-8000-000000000912";
const LANE_GROUP_ID = "019e0000-0000-7000-8000-000000000920";
const LANE_ONE_ID = "019e0000-0000-7000-8000-000000000921";
const LANE_TWO_ID = "019e0000-0000-7000-8000-000000000922";
const TASK_ID = "019e0000-0000-7000-8000-000000000931";
const VIEWER_ID = "019e0000-0000-7000-8000-000000000941";

const at = (second: number) =>
  `2026-06-05T12:00:${String(second).padStart(2, "0")}.000Z`;

const timelineFor = (
  visits: NodeVisitContract[],
  overrides: Partial<Parameters<typeof buildRunExecution>[0]> = {},
) => {
  const execution = buildRunExecution({
    id: EXECUTION_ID,
    visits,
    ...overrides,
  });
  const steps = buildExecutionStepItems({
    execution,
    version: buildRunVersion(),
  });
  return buildVisitTimeline(execution, steps, VIEWER_ID);
};

const rowTexts = (view: ReturnType<typeof render>) =>
  within(view.getByRole("list", { name: "Steps" }))
    .getAllByRole("button")
    .map((row) => row.textContent);

describe("VisitTimeline", () => {
  beforeEach(() => {
    installDom();
  });

  afterEach(() => {
    cleanup();
  });

  test("lists every visit oldest first, with its state note", () => {
    const entries = timelineFor([
      buildVisit({
        id: DONE_ID,
        nodeId: "done",
        nodeKind: "succeed",
        createdAt: at(30),
      }),
      buildVisit({
        id: APPROVE_ID,
        nodeId: "approve",
        nodeKind: "wait",
        waitFor: "decision",
        result: { action: "approve", body: null },
        resolvedByUserId: VIEWER_ID as NodeVisitContract["resolvedByUserId"],
        createdAt: at(20),
      }),
      buildVisit({
        id: REVIEW_ID,
        nodeId: "review",
        tasks: [buildVisitTask({ taskId: TASK_ID })],
        createdAt: at(10),
      }),
    ]);
    const view = render(
      <VisitTimeline
        entries={entries}
        selectedVisitId={null}
        onSelect={() => {}}
      />,
    );

    expect(view.getByText("3 steps, oldest first")).toBeTruthy();
    const rows = rowTexts(view);
    expect(rows[0]).toContain("Review");
    expect(rows[0]).toContain("succeeded");
    expect(rows[1]).toContain("approve");
    expect(rows[1]).toContain("you chose approve");
    expect(rows[2]).toContain("done");
    expect(rows[2]).toContain("finished");
  });

  test("notes a visit's error and a fail end's reason", () => {
    const entries = timelineFor(
      [
        buildVisit({
          id: REVIEW_ID,
          nodeId: "review",
          status: "failed",
          error: { name: "StepFailed", message: "Agent crashed" },
          createdAt: at(10),
        }),
        buildVisit({
          id: DONE_ID,
          nodeId: "stop",
          nodeKind: "fail",
          createdAt: at(20),
        }),
      ],
      {
        endNodeId: "stop",
        error: { name: "NotReproduced", message: "Could not reproduce" },
      },
    );

    expect(entries.map((entry) => entry.note)).toEqual([
      "Agent crashed",
      "ended · NotReproduced",
    ]);
  });

  test("indents lane visits behind ⑂ with the lane's name", () => {
    const entries = timelineFor(
      [
        buildVisit({
          id: LANE_ONE_VISIT_ID,
          nodeId: "review",
          laneId: LANE_ONE_ID as NodeVisitContract["laneId"],
          createdAt: at(10),
        }),
        buildVisit({
          id: LANE_TWO_VISIT_ID,
          nodeId: "review",
          laneId: LANE_TWO_ID as NodeVisitContract["laneId"],
          createdAt: at(11),
        }),
      ],
      {
        lanes: [
          buildLane({ id: LANE_ONE_ID, laneGroupId: LANE_GROUP_ID, index: 0 }),
          buildLane({ id: LANE_TWO_ID, laneGroupId: LANE_GROUP_ID, index: 1 }),
        ],
      },
    );
    const view = render(
      <VisitTimeline
        entries={entries}
        selectedVisitId={null}
        onSelect={() => {}}
      />,
    );

    const [first, second] = rowTexts(view);
    expect(first).toContain("⑂ Review · Item 1");
    expect(second).toContain("⑂ Review · Item 2");
  });

  test("hides and shows superseded visits, and selects a visit", () => {
    const onSelect = mock((entry: VisitTimelineEntry) => entry.visit.id);
    const entries = timelineFor([
      buildVisit({
        id: REVIEW_OLD_ID,
        nodeId: "review",
        status: "superseded",
        createdAt: at(10),
      }),
      buildVisit({
        id: REVIEW_ID,
        nodeId: "review",
        status: "active",
        createdAt: at(20),
      }),
    ]);
    const view = render(
      <VisitTimeline
        entries={entries}
        selectedVisitId={REVIEW_ID}
        onSelect={onSelect}
      />,
    );

    expect(rowTexts(view)).toHaveLength(2);
    fireEvent.click(view.getByRole("button", { name: "Hide 1 superseded" }));
    const remaining = rowTexts(view);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toContain("queued");
    fireEvent.click(view.getByRole("button", { name: "Show 1 superseded" }));
    expect(rowTexts(view)).toHaveLength(2);

    const [, current] = within(
      view.getByRole("list", { name: "Steps" }),
    ).getAllByRole("button");
    if (!current) throw new Error("Expected the current visit's row");
    expect(current.getAttribute("aria-current")).toBe("step");
    fireEvent.click(current);
    expect(onSelect.mock.results.at(-1)?.value).toBe(REVIEW_ID);
  });
});
