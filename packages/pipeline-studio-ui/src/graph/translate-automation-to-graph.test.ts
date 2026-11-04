import { describe, expect, test } from "bun:test";
import type { StudioEdge, StudioNode } from "./studio-graph-types";
import { kindLabel } from "./studio-graph-visuals";
import {
  AutomationGraphError,
  translateAutomationToGraph,
  type AutomationGraphInput,
} from "./translate-automation-to-graph";

const NO_PIPELINES: ReadonlyMap<string, string> = new Map();

function labelled(value: string) {
  return { path: "event.child.labels", op: "contains", value };
}

const TRIAGE: AutomationGraphInput = {
  key: "triage",
  document: {
    kind: "automation",
    schemaVersion: 1,
    key: "triage",
    scope: "project",
    rules: [
      {
        event: "workItem.created",
        next: { routes: [{ kind: "pipeline", to: "triage", on: "workItem" }] },
      },
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
      {
        event: "workItem.created",
        next: { routes: [{ kind: "step", to: "notify", on: "workItem" }] },
      },
    ],
  },
};

const WAYFINDER: AutomationGraphInput = {
  key: "wayfinder",
  document: {
    kind: "automation",
    schemaVersion: 1,
    key: "wayfinder",
    scope: "workItem",
    rules: [
      {
        event: "self.attached",
        next: { routes: [{ kind: "step", to: "plan", on: "workItem" }] },
      },
      {
        event: "child.ready",
        next: {
          routes: [
            {
              when: labelled("wayfinder:research"),
              kind: "step",
              to: "research",
              on: "child",
            },
            {
              when: labelled("wayfinder:build"),
              kind: "pipeline",
              to: "build",
              on: "child",
            },
          ],
          otherwise: { kind: "skip" },
        },
      },
      {
        event: "child.closed",
        next: {
          match: "all",
          routes: [
            { kind: "step", to: "plan", on: "workItem" },
            {
              when: labelled("wayfinder:research"),
              kind: "step",
              to: "plan",
              on: "workItem",
            },
          ],
        },
      },
    ],
  },
};

function nodesOf(graph: { nodes: StudioNode[] }) {
  return graph.nodes.map((node) => [
    node.id,
    node.data.kind,
    node.data.label,
    kindLabel(node.data),
  ]);
}

function edgesOf(graph: { edges: StudioEdge[] }) {
  return graph.edges.map((edge) => [
    edge.source,
    edge.target,
    edge.data?.kind,
    edge.label,
    edge.data?.order,
  ]);
}

describe("translateAutomationToGraph", () => {
  test("events link straight to their rules; two rules can share an event", () => {
    const graph = translateAutomationToGraph(
      TRIAGE,
      new Map([["triage", "Triage a work item"]]),
    );
    expect(nodesOf(graph)).toEqual([
      [
        "event:workItem.created",
        "event",
        "workItem.created",
        "Event · top-level work item",
      ],
      [
        "event:workItem.label.added",
        "event",
        "workItem.label.added",
        "Event · top-level work item",
      ],
      ["rule:0", "rule", "Rule 1", "Rule 1 · workItem.created"],
      ["target:0:0", "pipeline", "Triage a work item", "Pipeline · triage"],
      ["rule:1", "rule", "Rule 2", "Rule 2 · workItem.label.added"],
      ["target:1:0", "action", "wayfinder", "Attach · wayfinder"],
      ["rule:2", "rule", "Rule 3", "Rule 3 · workItem.created"],
      ["target:2:0", "action", "notify", "Step · notify"],
    ]);
    expect(edgesOf(graph)).toEqual([
      ["event:workItem.created", "rule:0", "start", undefined, null],
      ["rule:0", "target:0:0", "route", undefined, null],
      ["event:workItem.label.added", "rule:1", "start", undefined, null],
      ["rule:1", "target:1:0", "route", 'event.label == "wayfinder"', null],
      ["event:workItem.created", "rule:2", "start", undefined, null],
      ["rule:2", "target:2:0", "route", undefined, null],
    ]);
  });

  test("has no automation node; each rule's only incoming edge is from its event", () => {
    const graph = translateAutomationToGraph(WAYFINDER, NO_PIPELINES);
    expect(graph.nodes.map((node) => node.data.kind)).not.toContain(
      "automation",
    );
    for (const rule of graph.nodes.filter((n) => n.data.kind === "rule")) {
      const incoming = graph.edges.filter((edge) => edge.target === rule.id);
      expect(incoming.map((edge) => [edge.source, edge.data?.kind])).toEqual([
        [`event:${String(rule.data.event)}`, "start"],
      ]);
    }
  });

  test("a work-item automation: event scope, ordered, otherwise and all rules", () => {
    const graph = translateAutomationToGraph(WAYFINDER, NO_PIPELINES);
    expect(nodesOf(graph)).toEqual([
      [
        "event:self.attached",
        "event",
        "self.attached",
        "Event · own work item",
      ],
      ["event:child.ready", "event", "child.ready", "Event · child work item"],
      [
        "event:child.closed",
        "event",
        "child.closed",
        "Event · child work item",
      ],
      ["rule:0", "rule", "Rule 1", "Rule 1 · self.attached"],
      ["target:0:0", "action", "plan", "Step · plan"],
      ["rule:1", "rule", "Rule 2", "Rule 2 · child.ready"],
      ["target:1:0", "action", "research", "Step · research · on child"],
      [
        "target:1:1",
        "pipeline",
        "build",
        "Pipeline · build (not found) · on child",
      ],
      ["target:1:otherwise", "action", "Skip", "Skip"],
      ["rule:2", "rule", "Rule 3", "Rule 3 · child.closed"],
      ["target:2:0", "action", "plan", "Step · plan"],
      ["target:2:1", "action", "plan", "Step · plan"],
    ]);
    const research = 'event.child.labels contains "wayfinder:research"';
    expect(edgesOf(graph)).toEqual([
      ["event:self.attached", "rule:0", "start", undefined, null],
      ["rule:0", "target:0:0", "route", undefined, null],
      ["event:child.ready", "rule:1", "start", undefined, null],
      ["rule:1", "target:1:0", "route", research, 1],
      [
        "rule:1",
        "target:1:1",
        "route",
        'event.child.labels contains "wayfinder:build"',
        2,
      ],
      ["rule:1", "target:1:otherwise", "otherwise", "otherwise", null],
      ["event:child.closed", "rule:2", "start", undefined, null],
      ["rule:2", "target:2:0", "route", undefined, null],
      ["rule:2", "target:2:1", "route", research, null],
    ]);

    const data = (id: string) =>
      graph.nodes.find((node) => node.id === id)?.data;
    expect(data("rule:1")?.match).toBe("first");
    expect(data("rule:2")?.match).toBe("all");
    expect(data("target:1:0")?.subject).toBe("child");
    expect(data("target:0:0")?.subject).toBe("workItem");
    expect(data("target:1:1")?.resolved).toBe(false);
  });

  test("the same step key in several routes gives distinct nodes", () => {
    const graph = translateAutomationToGraph(WAYFINDER, NO_PIPELINES);
    expect(
      graph.nodes
        .filter((node) => node.data.targetKey === "plan")
        .map((node) => node.id),
    ).toEqual(["target:0:0", "target:2:0", "target:2:1"]);
    expect(new Set(graph.nodes.map((node) => node.id)).size).toBe(
      graph.nodes.length,
    );
  });

  test("a pipeline target shows its name when known and its key when not", () => {
    const known = translateAutomationToGraph(
      TRIAGE,
      new Map([["triage", "Triage a work item"]]),
    ).nodes.find((node) => node.id === "target:0:0")?.data;
    expect(known?.label).toBe("Triage a work item");
    expect(known?.resolved).toBe(true);
    expect(known?.targetKey).toBe("triage");

    const missing = translateAutomationToGraph(TRIAGE, NO_PIPELINES).nodes.find(
      (node) => node.id === "target:0:0",
    )?.data;
    expect(missing?.label).toBe("triage");
    expect(missing?.resolved).toBe(false);
    expect(missing && kindLabel(missing)).toBe("Pipeline · triage (not found)");
  });

  test("a document with no rules gives an empty graph", () => {
    const graph = translateAutomationToGraph(
      {
        key: "idle",
        document: {
          kind: "automation",
          schemaVersion: 1,
          key: "idle",
          scope: "project",
          rules: [],
        },
      },
      NO_PIPELINES,
    );
    expect(graph).toEqual({ nodes: [], edges: [] });
  });

  test("a malformed document throws an error naming its automation", () => {
    const broken: AutomationGraphInput = {
      key: "broken",
      document: { kind: "automation", schemaVersion: 1, key: "broken" },
    };
    expect(() => translateAutomationToGraph(broken, NO_PIPELINES)).toThrow(
      AutomationGraphError,
    );
    try {
      translateAutomationToGraph(broken, NO_PIPELINES);
    } catch (error) {
      expect((error as AutomationGraphError).automationKey).toBe("broken");
      expect((error as Error).message).toContain('"broken"');
    }
  });
});
