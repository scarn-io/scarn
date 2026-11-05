import { describe, expect, test } from "bun:test";
import {
  automation,
  NO_GRANTS,
  NO_PIPELINES,
  WAYFINDER,
  WAYFINDER_GRANTS,
} from "./automation-round-fixtures";
import {
  layoutAutomationRound,
  ROUND_CHANNEL_GAP,
  ROUND_COLUMN_WIDTH,
  type AutomationRoundLayout,
  type RoundEdgeData,
  type RoundMemberData,
} from "./automation-round-layout";
import { buildAutomationRound } from "./automation-round-model";

const wayfinder = () =>
  layoutAutomationRound(
    buildAutomationRound(WAYFINDER, WAYFINDER_GRANTS, NO_PIPELINES),
  );

function member(layout: AutomationRoundLayout, id: string): RoundMemberData {
  const node = layout.nodes.find((candidate) => candidate.id === id);
  if (node?.data.kind === "lane" || node === undefined) {
    throw new Error(`no member node ${id}`);
  }
  return node.data;
}

function edgeData(
  layout: AutomationRoundLayout,
  source: string,
  target: string,
): RoundEdgeData & { label: unknown } {
  const edge = layout.edges.find(
    (candidate) => candidate.source === source && candidate.target === target,
  );
  if (!edge?.data) throw new Error(`no edge ${source} → ${target}`);
  return { ...edge.data, label: edge.label };
}

const laneIds = (layout: AutomationRoundLayout) =>
  layout.nodes
    .filter((node) => node.data.kind === "lane" && node.data.lane !== null)
    .map((node) => node.id);

describe("layoutAutomationRound", () => {
  test("lanes come automation, this work item, children; empty ones are dropped", () => {
    expect(laneIds(wayfinder())).toEqual([
      "lane:automation",
      "lane:workItem",
      "lane:child",
    ]);
    const projectWide = layoutAutomationRound(
      buildAutomationRound(
        automation("default", "project", [
          {
            event: "workItem.ready",
            next: { routes: [{ kind: "pipeline", to: "bug", on: "workItem" }] },
          },
        ]),
        NO_GRANTS,
        NO_PIPELINES,
      ),
    );
    expect(laneIds(projectWide)).toEqual(["lane:automation", "lane:workItem"]);
    const tops = projectWide.nodes
      .filter((node) => node.data.kind === "lane")
      .map((node) => node.position.y);
    expect(tops[0]).toBeLessThan(tops[1] ?? 0);
  });

  test("wayfinder reads left to right as one round", () => {
    const layout = wayfinder();
    const columns = Object.fromEntries(
      layout.nodes
        .filter((node) => node.data.kind !== "lane")
        .map((node) => [node.id, member(layout, node.id).column]),
    );
    expect(columns).toEqual({
      "junction:0": 0,
      "step:plan@workItem": 1,
      "junction:1": 2,
      "end:closed": 2,
      "step:research@child": 3,
      "step:prototype@child": 3,
      "step:grilling@child": 3,
      "person:wayfinder:task": 3,
      "junction:2": 4,
    });
    expect(
      layout.nodes.find((node) => node.id === "step:plan@workItem")?.position.x,
    ).toBe(ROUND_COLUMN_WIDTH);
    expect(member(layout, "junction:0").lane).toBe("automation");
    expect(member(layout, "end:closed").lane).toBe("workItem");
    expect(member(layout, "person:wayfinder:task").lane).toBe("child");
  });

  test("the next-round edge is a back edge in a channel above the lanes", () => {
    const layout = wayfinder();
    const nextRound = edgeData(layout, "junction:2", "step:plan@workItem");
    expect(nextRound.path).toBe("back");
    expect(nextRound.label).toBe("↻ next round");
    const unblocks = edgeData(layout, "junction:2", "junction:1");
    expect(unblocks.path).toBe("back");
    expect(unblocks.label).toBe("unblocks siblings");
    expect(
      layout.edges.filter((edge) => edge.data?.path === "back"),
    ).toHaveLength(2);
    const firstLane = layout.nodes.find(
      (node) => node.id === "lane:automation",
    );
    expect(nextRound.channelY).toBeLessThan(firstLane?.position.y ?? 0);
  });

  test("nodes sharing a lane and column stack in document order", () => {
    const layout = wayfinder();
    const stacked = [
      "step:research@child",
      "step:prototype@child",
      "step:grilling@child",
      "person:wayfinder:task",
    ];
    expect(stacked.map((id) => member(layout, id).row)).toEqual([0, 1, 2, 3]);
    const ys = stacked.map(
      (id) => layout.nodes.find((node) => node.id === id)?.position.y ?? 0,
    );
    expect([...ys].sort((a, b) => a - b)).toEqual(ys);
    expect(new Set(ys).size).toBe(4);
  });

  test("labels sit next to the target on fan-out, else next to the source", () => {
    const layout = wayfinder();
    expect(edgeData(layout, "junction:1", "step:research@child").labelAt).toBe(
      "target",
    );
    expect(edgeData(layout, "step:plan@workItem", "end:closed").labelAt).toBe(
      "target",
    );
    expect(edgeData(layout, "step:research@child", "junction:2").labelAt).toBe(
      "source",
    );
    expect(edgeData(layout, "junction:1", "step:research@child").label).toBe(
      "1. wayfinder:research",
    );
  });

  test("two back edges get distinct channels, the shorter loop lower", () => {
    const layout = wayfinder();
    const unblocks = edgeData(layout, "junction:2", "junction:1");
    const nextRound = edgeData(layout, "junction:2", "step:plan@workItem");
    expect(unblocks.channelY).toBe(-ROUND_CHANNEL_GAP);
    expect(nextRound.channelY).toBe(-2 * ROUND_CHANNEL_GAP);
    expect(unblocks.exitDx).not.toBe(nextRound.exitDx);
    expect(layout.nodes.some((node) => node.id === "lane:channels")).toBe(true);
  });
});
