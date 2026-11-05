import { describe, expect, test } from "bun:test";
import { AutomationGraphError } from "./automation-document-parse";
import {
  automation,
  labelled,
  NO_GRANTS,
  NO_PIPELINES,
  selfGrant as self,
  WAYFINDER,
  WAYFINDER_GRANTS,
  WAYFINDER_LABELS,
} from "./automation-round-fixtures";
import { buildAutomationRound } from "./automation-round-model";
import type { AutomationRoundModel } from "./automation-round-types";

const DEFAULT = automation("default", "project", [
  {
    event: "workItem.ready",
    next: {
      routes: [
        {
          when: { path: "event.workItem.labels", op: "contains", value: "x" },
          kind: "pipeline",
          to: "feature",
          on: "workItem",
        },
      ],
      otherwise: { kind: "pipeline", to: "bug", on: "workItem" },
    },
  },
]);

function nodesOf(model: AutomationRoundModel) {
  return model.nodes.map((node) => [node.id, node.kind, node.label]);
}

function edgesOf(model: AutomationRoundModel) {
  return model.edges.map((edge) => [
    edge.kind,
    edge.source,
    edge.target,
    edge.label,
    edge.kind === "soft" ? edge.provenance : edge.order,
  ]);
}

const softEdges = (model: AutomationRoundModel) =>
  edgesOf(model).filter(([kind]) => kind === "soft");

describe("buildAutomationRound", () => {
  test("default: two routes, no soft links", () => {
    const model = buildAutomationRound(
      DEFAULT,
      NO_GRANTS,
      new Map([["bug", "Fix a bug"]]),
    );
    expect(model.automationKey).toBe("default");
    expect(nodesOf(model)).toEqual([
      ["junction:0", "junction", "workItem.ready"],
      ["pipeline:feature@workItem", "pipeline", "feature"],
      ["pipeline:bug@workItem", "pipeline", "Fix a bug"],
    ]);
    expect(edgesOf(model)).toEqual([
      [
        "route",
        "junction:0",
        "pipeline:feature@workItem",
        'event.workItem.labels contains "x"',
        null,
      ],
      ["route", "junction:0", "pipeline:bug@workItem", "otherwise", null],
    ]);
  });

  test("wayfinder with grants: soft links, one person, the unblocks edge", () => {
    const model = buildAutomationRound(
      WAYFINDER,
      WAYFINDER_GRANTS,
      NO_PIPELINES,
    );
    expect(nodesOf(model)).toEqual([
      ["junction:0", "junction", "self.attached"],
      ["step:plan@workItem", "step", "plan"],
      ["junction:1", "junction", "child.ready"],
      ["step:research@child", "step", "research"],
      ["step:prototype@child", "step", "prototype"],
      ["step:grilling@child", "step", "grilling"],
      ["junction:2", "junction", "child.closed"],
      ["end:closed", "end", "Closed"],
      ["person:wayfinder:task", "person", "A person"],
    ]);
    expect(edgesOf(model)).toEqual([
      ["route", "junction:0", "step:plan@workItem", undefined, null],
      ["route", "junction:1", "step:research@child", "wayfinder:research", 1],
      ["route", "junction:1", "step:prototype@child", "wayfinder:prototype", 2],
      ["route", "junction:1", "step:grilling@child", "wayfinder:grilling", 3],
      ["route", "junction:2", "step:plan@workItem", undefined, null],
      [
        "soft",
        "step:plan@workItem",
        "junction:1",
        "creates children",
        "declared",
      ],
      [
        "soft",
        "step:plan@workItem",
        "end:closed",
        "closes work item",
        "declared",
      ],
      ["soft", "step:research@child", "junction:2", "closes child", "declared"],
      [
        "soft",
        "step:prototype@child",
        "junction:2",
        "closes child",
        "declared",
      ],
      ["soft", "step:grilling@child", "junction:2", "closes child", "declared"],
      [
        "soft",
        "junction:1",
        "person:wayfinder:task",
        "wayfinder:task",
        "declared",
      ],
      [
        "soft",
        "person:wayfinder:task",
        "junction:2",
        "closes by hand",
        "declared",
      ],
      ["soft", "junction:2", "junction:1", "unblocks siblings", "engine"],
    ]);
    const creates = model.edges.find(
      (edge) => edge.kind === "soft" && edge.label === "creates children",
    );
    expect(creates?.kind === "soft" ? creates.labels : null).toEqual(
      WAYFINDER_LABELS,
    );
  });

  test("wayfinder with no grants: routes and the engine edge only", () => {
    const model = buildAutomationRound(WAYFINDER, NO_GRANTS, NO_PIPELINES);
    expect(model.nodes.map((node) => node.kind)).not.toContain("person");
    expect(model.nodes.map((node) => node.kind)).not.toContain("end");
    expect(softEdges(model)).toEqual([
      ["soft", "junction:2", "junction:1", "unblocks siblings", "engine"],
    ]);
  });

  test("a work-item step with close on children links to child.closed", () => {
    const model = buildAutomationRound(
      automation("sweep", "workItem", [
        {
          event: "self.attached",
          next: { routes: [{ kind: "step", to: "sweep", on: "workItem" }] },
        },
        {
          event: "child.closed",
          next: { routes: [{ kind: "step", to: "sweep", on: "workItem" }] },
        },
      ]),
      new Map([
        [
          "sweep",
          [{ resource: "workItem", action: "close", scope: "children" }],
        ],
      ]),
      NO_PIPELINES,
    );
    expect(softEdges(model)).toEqual([
      [
        "soft",
        "step:sweep@workItem",
        "junction:1",
        "closes children",
        "declared",
      ],
    ]);
  });

  test("a create grant links to child.created too, and only to handled events", () => {
    const model = buildAutomationRound(
      automation("spawn", "workItem", [
        {
          event: "self.attached",
          next: { routes: [{ kind: "step", to: "plan", on: "workItem" }] },
        },
        {
          event: "child.created",
          next: { routes: [{ kind: "step", to: "notify", on: "child" }] },
        },
      ]),
      WAYFINDER_GRANTS,
      NO_PIPELINES,
    );
    expect(softEdges(model)).toEqual([
      [
        "soft",
        "step:plan@workItem",
        "junction:1",
        "creates children",
        "declared",
      ],
      [
        "soft",
        "step:plan@workItem",
        "end:closed",
        "closes work item",
        "declared",
      ],
    ]);
  });

  test("a step with only update and comment draws no links", () => {
    const model = buildAutomationRound(
      WAYFINDER,
      new Map([["research", [self("update"), self("comment")]]]),
      NO_PIPELINES,
    );
    expect(
      model.edges.filter(
        (edge) => edge.kind === "soft" && edge.provenance === "declared",
      ),
    ).toEqual([]);
  });

  test("a rule with match all: one junction per rule, unordered routes", () => {
    const model = buildAutomationRound(
      automation("fanout", "workItem", [
        {
          event: "child.closed",
          next: {
            match: "all",
            routes: [
              { kind: "step", to: "plan", on: "workItem" },
              { kind: "step", to: "review", on: "child" },
            ],
          },
        },
        {
          event: "child.closed",
          next: { routes: [{ kind: "step", to: "plan", on: "workItem" }] },
        },
      ]),
      NO_GRANTS,
      NO_PIPELINES,
    );
    expect(nodesOf(model)).toEqual([
      ["junction:0", "junction", "child.closed"],
      ["step:plan@workItem", "step", "plan"],
      ["step:review@child", "step", "review"],
      ["junction:1", "junction", "child.closed"],
    ]);
    expect(model.nodes[0]).toMatchObject({ match: "all" });
    expect(edgesOf(model)).toEqual([
      ["route", "junction:0", "step:plan@workItem", undefined, null],
      ["route", "junction:0", "step:review@child", undefined, null],
      ["route", "junction:1", "step:plan@workItem", undefined, null],
    ]);
  });

  test("skip targets are dropped", () => {
    const model = buildAutomationRound(
      automation("skippy", "workItem", [
        {
          event: "child.ready",
          next: {
            routes: [{ when: labelled("a"), kind: "skip" }],
            otherwise: { kind: "skip" },
          },
        },
      ]),
      NO_GRANTS,
      NO_PIPELINES,
    );
    expect(nodesOf(model)).toEqual([["junction:0", "junction", "child.ready"]]);
    expect(model.edges).toEqual([]);
  });

  test("an attach target is drawn and not followed", () => {
    const model = buildAutomationRound(
      automation("triage", "project", [
        {
          event: "workItem.label.added",
          next: {
            routes: [
              {
                when: { path: "event.label", op: "equal", value: "wayfinder" },
                kind: "attach",
                automation: "wayfinder",
              },
            ],
          },
        },
      ]),
      WAYFINDER_GRANTS,
      NO_PIPELINES,
    );
    expect(nodesOf(model)).toEqual([
      ["junction:0", "junction", "workItem.label.added"],
      ["attach:wayfinder", "attach", "wayfinder"],
    ]);
    expect(edgesOf(model)).toEqual([
      [
        "route",
        "junction:0",
        "attach:wayfinder",
        'event.label == "wayfinder"',
        null,
      ],
    ]);
  });

  test("a step key with no grants draws its target with no links", () => {
    const grants = new Map(WAYFINDER_GRANTS);
    grants.delete("research");
    const model = buildAutomationRound(WAYFINDER, grants, NO_PIPELINES);
    expect(model.nodes.map((node) => node.id)).toContain("step:research@child");
    expect(
      model.edges.filter(
        (edge) => edge.kind === "soft" && edge.source === "step:research@child",
      ),
    ).toEqual([]);
  });

  test("an invalid document throws AutomationGraphError", () => {
    expect(() =>
      buildAutomationRound(
        { key: "broken", document: { kind: "automation" } },
        NO_GRANTS,
        NO_PIPELINES,
      ),
    ).toThrow(AutomationGraphError);
  });
});
