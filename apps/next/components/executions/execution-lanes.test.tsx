import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import {
  parseUuidV7,
  type LaneGroupContract,
} from "@scarn/api/frontend-contracts";
import { ExecutionLanes } from "./execution-lanes";
import {
  buildLane,
  buildRunExecution,
  buildVisit,
} from "./execution-detail-view.test-helpers";
import { laneLabel, visitLabel } from "./visit-labels";
import { installDom } from "@/tests/support/install-dom";

const EXECUTION_ID = "019e0000-0000-7000-8000-000000000a01";
const CLASSIFY_VISIT_ID = "019e0000-0000-7000-8000-000000000a02";
const GROUP_ID = "019e0000-0000-7000-8000-000000000a10";
const REPRO_LANE_ID = "019e0000-0000-7000-8000-000000000a11";
const SECURITY_LANE_ID = "019e0000-0000-7000-8000-000000000a12";
const BACKLOG_LANE_ID = "019e0000-0000-7000-8000-000000000a13";
const MERGED_LANE_ID = "019e0000-0000-7000-8000-000000000a14";
const REPRO_VISIT_ID = "019e0000-0000-7000-8000-000000000a21";
const SECURITY_VISIT_ID = "019e0000-0000-7000-8000-000000000a22";
const BACKLOG_VISIT_ID = "019e0000-0000-7000-8000-000000000a23";
const MERGE_VISIT_ID = "019e0000-0000-7000-8000-000000000a24";
const EACH_GROUP_ID = "019e0000-0000-7000-8000-000000000a30";
const ITEM_ONE_ID = "019e0000-0000-7000-8000-000000000a31";
const ITEM_TWO_ID = "019e0000-0000-7000-8000-000000000a32";

const TITLES: Record<string, string> = {
  classify: "Classify issue",
  reproduce: "Reproduce bug",
  security: "Notify security",
  backlog: "Add to backlog",
  writeTest: "Write failing test",
  plan: "Plan changes",
};
const nodeTitle = (nodeId: string) => TITLES[nodeId] ?? nodeId;

function group(
  overrides: Partial<Omit<LaneGroupContract, "id">> & { id: string },
): LaneGroupContract {
  return {
    parentLaneId: null,
    spawnedByVisitId: parseUuidV7(CLASSIFY_VISIT_ID),
    kind: "each",
    laneCount: 0,
    maxConcurrency: null,
    toleratedFailures: { count: 0 },
    status: "open",
    ...overrides,
    id: parseUuidV7(overrides.id),
  };
}

const classifyVisit = buildVisit({ id: CLASSIFY_VISIT_ID, nodeId: "classify" });

function laneVisit(
  id: string,
  nodeId: string,
  laneId: string,
  createdAt: string,
  overrides: Partial<Parameters<typeof buildVisit>[0]> = {},
) {
  return buildVisit({
    id,
    nodeId,
    laneId: parseUuidV7(laneId),
    fromVisitId: parseUuidV7(CLASSIFY_VISIT_ID),
    transition: { kind: "route", index: 0 },
    createdAt,
    ...overrides,
  });
}

const allExecution = buildRunExecution({
  id: EXECUTION_ID,
  visits: [
    classifyVisit,
    laneVisit(
      REPRO_VISIT_ID,
      "reproduce",
      REPRO_LANE_ID,
      "2026-06-05T12:01:00.000Z",
    ),
    laneVisit(
      SECURITY_VISIT_ID,
      "security",
      SECURITY_LANE_ID,
      "2026-06-05T12:01:01.000Z",
    ),
    laneVisit(
      BACKLOG_VISIT_ID,
      "backlog",
      BACKLOG_LANE_ID,
      "2026-06-05T12:01:02.000Z",
    ),
    laneVisit(
      MERGE_VISIT_ID,
      "writeTest",
      MERGED_LANE_ID,
      "2026-06-05T12:02:00.000Z",
      {
        fromVisitId: null,
        fromLaneGroupId: parseUuidV7(GROUP_ID),
        transition: { kind: "merge", index: 0 },
      },
    ),
  ],
  laneGroups: [group({ id: GROUP_ID, kind: "all", laneCount: 3 })],
  lanes: [
    buildLane({
      id: REPRO_LANE_ID,
      laneGroupId: GROUP_ID,
      index: 0,
      route: { kind: "route", index: 0 },
      status: "arrived",
      arrivedAtNodeId: "writeTest",
      mergedIntoVisitId: parseUuidV7(MERGE_VISIT_ID),
    }),
    buildLane({
      id: SECURITY_LANE_ID,
      laneGroupId: GROUP_ID,
      index: 1,
      route: { kind: "route", index: 1 },
      status: "arrived",
      arrivedAtNodeId: "writeTest",
      mergedIntoVisitId: parseUuidV7(MERGE_VISIT_ID),
    }),
    buildLane({
      id: BACKLOG_LANE_ID,
      laneGroupId: GROUP_ID,
      index: 2,
      route: { kind: "otherwise", index: 0 },
      status: "ended",
    }),
    buildLane({
      id: MERGED_LANE_ID,
      laneGroupId: GROUP_ID,
      index: 3,
      route: { kind: "merge", index: 0 },
      origin: "merge",
      status: "active",
    }),
  ],
});

const eachExecution = buildRunExecution({
  id: EXECUTION_ID,
  visits: [buildVisit({ id: CLASSIFY_VISIT_ID, nodeId: "plan" })],
  laneGroups: [
    group({ id: EACH_GROUP_ID, kind: "each", laneCount: 2, maxConcurrency: 1 }),
  ],
  lanes: [
    buildLane({ id: ITEM_ONE_ID, laneGroupId: EACH_GROUP_ID, index: 0 }),
    buildLane({
      id: ITEM_TWO_ID,
      laneGroupId: EACH_GROUP_ID,
      index: 1,
      status: "pending",
    }),
  ],
});

function laneById(
  execution: typeof allExecution,
  id: string,
): (typeof allExecution)["lanes"][number] {
  const lane = execution.lanes.find((candidate) => candidate.id === id);
  if (!lane) throw new Error(`no lane ${id}`);
  return lane;
}

describe("laneLabel", () => {
  test("names all lanes by their route's target node, or Otherwise", () => {
    expect(
      laneLabel(allExecution, laneById(allExecution, REPRO_LANE_ID), nodeTitle),
    ).toBe("Reproduce bug");
    expect(
      laneLabel(
        allExecution,
        laneById(allExecution, BACKLOG_LANE_ID),
        nodeTitle,
      ),
    ).toBe("Otherwise");
  });

  test("names a continuation lane after the lanes that merged into it", () => {
    expect(
      laneLabel(
        allExecution,
        laneById(allExecution, MERGED_LANE_ID),
        nodeTitle,
      ),
    ).toBe("Merged (Reproduce bug + Notify security)");
  });

  test("names each lanes by item number", () => {
    expect(laneLabel(eachExecution, laneById(eachExecution, ITEM_TWO_ID))).toBe(
      "Item 2",
    );
  });

  test("labels a lane's visit with the lane's name", () => {
    const visit = allExecution.visits.find(
      (candidate) => candidate.id === MERGE_VISIT_ID,
    );
    if (!visit) throw new Error("no merge visit");
    expect(visitLabel(allExecution, visit, 0, nodeTitle)).toBe(
      "Merged (Reproduce bug + Notify security)",
    );
    expect(visitLabel(allExecution, classifyVisit, 2)).toBe("Visit 3");
  });
});

describe("ExecutionLanes", () => {
  beforeEach(() => {
    installDom();
  });

  afterEach(() => {
    cleanup();
  });

  test("an all group counts routes and names lanes by route and merge", () => {
    const view = render(
      <ExecutionLanes
        execution={allExecution}
        nodeTitle={nodeTitle}
        onSelect={() => {}}
      />,
    );

    expect(view.getByText("All routes from Classify issue")).toBeTruthy();
    expect(view.getByText("3 routes")).toBeTruthy();
    expect(
      view.getByRole("button", { name: "Reproduce bug: Arrived at merge" }),
    ).toBeTruthy();
    expect(view.getByRole("button", { name: "Otherwise: Ended" })).toBeTruthy();
    expect(
      view.getByRole("button", {
        name: "Merged (Reproduce bug + Notify security): Active",
      }),
    ).toBeTruthy();
    expect(view.getByText("2 arrived at merge")).toBeTruthy();
  });

  test("an each group counts items and names lanes Item N", () => {
    const view = render(
      <ExecutionLanes
        execution={{
          ...eachExecution,
          laneGroups: eachExecution.laneGroups.map((entry) => ({
            ...entry,
            status: "merged" as const,
          })),
        }}
        nodeTitle={nodeTitle}
        onSelect={() => {}}
      />,
    );

    expect(view.getByText("Each from Plan changes")).toBeTruthy();
    expect(view.getByText("2 items · 1 at a time")).toBeTruthy();
    expect(view.getByRole("button", { name: "Item 1: Active" })).toBeTruthy();
    expect(view.getByText("Merged")).toBeTruthy();
  });
});
