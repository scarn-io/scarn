import { describe, expect, test } from "bun:test";
import type {
  NodeVisitContract,
  VisitTaskContract,
} from "@scarn/api/frontend-contracts";
import { computeNodeVisualStatus } from "./pipeline-graph-node-status";

function visit(
  nodeId: string,
  status: NodeVisitContract["status"],
  taskStatus?: VisitTaskContract["status"],
): NodeVisitContract {
  return {
    nodeId,
    status,
    tasks: taskStatus ? [{ status: taskStatus }] : [],
  } as unknown as NodeVisitContract;
}

const UNREACHED = {
  label: null,
  colorKey: null,
  badgeLabel: null,
  traversed: false,
};

describe("computeNodeVisualStatus", () => {
  test("returns nulls when no visit is at this node", () => {
    expect(
      computeNodeVisualStatus("analyze", [visit("other", "succeeded")]),
    ).toEqual(UNREACHED);
    expect(computeNodeVisualStatus("analyze", [])).toEqual(UNREACHED);
  });

  test("an active visit whose Task is claimed reads as running", () => {
    expect(
      computeNodeVisualStatus("analyze", [
        visit("analyze", "active", "running"),
      ]),
    ).toEqual({
      label: "Running",
      colorKey: "primary",
      badgeLabel: null,
      traversed: true,
    });
  });

  test("an active visit whose Task was abandoned surfaces it", () => {
    expect(
      computeNodeVisualStatus("analyze", [
        visit("analyze", "active", "abandoned"),
      ]).label,
    ).toBe("Abandoned");
  });

  test("lanes: worst status wins and the badge counts succeeded lanes", () => {
    expect(
      computeNodeVisualStatus("review", [
        visit("review", "succeeded"),
        visit("review", "succeeded"),
        visit("review", "failed"),
        visit("review", "active", "queued"),
      ]),
    ).toEqual({
      label: "Failed",
      colorKey: "error",
      badgeLabel: "2/4 succeeded",
      traversed: true,
    });
  });

  test("superseded visits are ignored", () => {
    expect(
      computeNodeVisualStatus("analyze", [
        visit("analyze", "superseded"),
        visit("analyze", "succeeded"),
      ]),
    ).toEqual({
      label: "Succeeded",
      colorKey: "success",
      badgeLabel: null,
      traversed: true,
    });
    expect(
      computeNodeVisualStatus("analyze", [visit("analyze", "superseded")]),
    ).toEqual(UNREACHED);
  });

  test("a waiting approval reads as waiting", () => {
    expect(
      computeNodeVisualStatus("approve", [visit("approve", "waiting")])
        .colorKey,
    ).toBe("warning");
  });
});
