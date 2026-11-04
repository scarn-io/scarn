import { describe, expect, test } from "bun:test";
import type { StudioIssue, StudioNodeShape } from "./studio-graph-types";
import {
  edgeDashArray,
  edgeLegendKinds,
  edgeTone,
  forkMarker,
  formatInOutCounts,
  highestSeverity,
  kindLabel,
  mergeBadge,
  nodeCaption,
  nodeInOutCounts,
  nodeLayoutSize,
  orderedEdgeLabel,
  pauseMarker,
  severityColor,
} from "./studio-graph-visuals";

function issue(
  overrides: Partial<StudioIssue> & {
    severity: StudioIssue["severity"];
  },
): StudioIssue {
  return {
    code: "unknown_node",
    message: "message",
    ...overrides,
  };
}

describe("highestSeverity", () => {
  test("returns null for an empty issue list", () => {
    expect(highestSeverity([])).toBeNull();
  });

  test("returns 'info' when every issue is info", () => {
    expect(highestSeverity([issue({ severity: "info" })])).toBe("info");
  });

  test("returns 'warning' when every issue is a warning", () => {
    expect(highestSeverity([issue({ severity: "warning" })])).toBe("warning");
  });

  test("returns 'warning' over 'info', regardless of order", () => {
    expect(
      highestSeverity([
        issue({ severity: "info" }),
        issue({ severity: "warning" }),
      ]),
    ).toBe("warning");
    expect(
      highestSeverity([
        issue({ severity: "warning" }),
        issue({ severity: "info" }),
      ]),
    ).toBe("warning");
  });

  test("returns 'error' when any issue is an error, regardless of order", () => {
    expect(
      highestSeverity([
        issue({ severity: "warning" }),
        issue({ severity: "error" }),
      ]),
    ).toBe("error");
    expect(
      highestSeverity([
        issue({ severity: "error" }),
        issue({ severity: "warning" }),
      ]),
    ).toBe("error");
    expect(
      highestSeverity([
        issue({ severity: "info" }),
        issue({ severity: "error" }),
      ]),
    ).toBe("error");
  });
});

describe("severityColor", () => {
  test("maps each severity (and null) to its theme-aware CSS variable", () => {
    expect(severityColor("error")).toBe("var(--studio-severity-error)");
    expect(severityColor("warning")).toBe("var(--studio-severity-warning)");
    expect(severityColor("info")).toBe("var(--studio-severity-info)");
    expect(severityColor(null)).toBe("var(--studio-severity-none)");
  });
});

describe("nodeInOutCounts", () => {
  test("counts a 'step' shape's input and result fields", () => {
    const shape: StudioNodeShape = {
      kind: "step",
      inputFields: [
        { name: "a", type: "string", required: true },
        { name: "b", type: "number", required: false },
      ],
      resultFields: [{ name: "out", type: "string", required: true }],
      resultSchemaJson: {},
      errors: [],
    };
    expect(nodeInOutCounts(shape)).toEqual({ inCount: 2, outCount: 1 });
  });

  test("returns null for a 'none' shape — no fabricated zero counts", () => {
    expect(nodeInOutCounts({ kind: "none" })).toBeNull();
  });
});

describe("edgeDashArray", () => {
  test("dashes catch edges and dots each edges", () => {
    expect(edgeDashArray({ kind: "catch", lane: null })).toBe("6 4");
    expect(edgeDashArray({ kind: "route", lane: "each" })).toBe("2 4");
    expect(
      edgeDashArray({ kind: "otherwise", lane: "partial" }),
    ).toBeUndefined();
    expect(edgeDashArray(undefined)).toBeUndefined();
  });
});

describe("nodeCaption", () => {
  test("adds the step key or wait kind after the node kind", () => {
    const base = { label: "x", issues: [], shape: { kind: "none" as const } };
    expect(nodeCaption({ ...base, kind: "step", stepKey: "triage" })).toBe(
      "step · triage",
    );
    expect(nodeCaption({ ...base, kind: "wait", waitFor: "decision" })).toBe(
      "wait · decision",
    );
    expect(nodeCaption({ ...base, kind: "succeed" })).toBe("succeed");
  });

  test("captions automations-graph nodes by their event or target", () => {
    const base = { label: "x", issues: [], shape: { kind: "none" as const } };
    expect(nodeCaption({ ...base, kind: "event", event: "child.ready" })).toBe(
      "event · child.ready",
    );
    expect(
      nodeCaption({
        ...base,
        kind: "rule",
        ruleIndex: 0,
        event: "child.ready",
      }),
    ).toBe("rule · child.ready");
    expect(
      nodeCaption({ ...base, kind: "pipeline", targetKey: "triage" }),
    ).toBe("pipeline · triage");
    expect(
      nodeCaption({
        ...base,
        kind: "action",
        actionKind: "attach",
        targetKey: "wayfinder",
      }),
    ).toBe("attach · wayfinder");
    expect(nodeCaption({ ...base, kind: "action", actionKind: "skip" })).toBe(
      "skip",
    );
  });
});

describe("forkMarker", () => {
  test("marks only all nodes as a fork", () => {
    expect(forkMarker({ match: "all" })).toBe("fork · all routes");
    expect(forkMarker({ match: "first" })).toBeNull();
    expect(forkMarker({})).toBeNull();
  });
});

describe("mergeBadge", () => {
  test("lists the routes a merge waits for", () => {
    expect(mergeBadge({ mergeWaitsFor: ["Review", "Test"] })).toBe(
      "merges: Review, Test",
    );
    expect(mergeBadge({ mergeWaitsFor: [] })).toBeNull();
    expect(mergeBadge({})).toBeNull();
  });
});

describe("pauseMarker", () => {
  test("shows how many rounds a step with maxTurns can pause for", () => {
    expect(pauseMarker({ kind: "step", maxTurns: 10 })).toBe(
      "pauses · up to 10 rounds",
    );
    expect(pauseMarker({ kind: "step", maxTurns: 1 })).toBe(
      "pauses · up to 1 round",
    );
  });

  test("is null without an explicit maxTurns, at 0, or off a step", () => {
    expect(pauseMarker({ kind: "step" })).toBeNull();
    expect(pauseMarker({ kind: "step", maxTurns: 0 })).toBeNull();
    expect(pauseMarker({ kind: "wait", maxTurns: 3 })).toBeNull();
  });

  test("adds a line to the step card", () => {
    expect(nodeLayoutSize({ kind: "step", maxTurns: 10 }).height).toBe(
      nodeLayoutSize({ kind: "step" }).height + 16,
    );
  });
});

describe("orderedEdgeLabel", () => {
  test("prefixes ordered routes with their number and leaves others alone", () => {
    expect(orderedEdgeLabel("x > 3", 1)).toBe("1. x > 3");
    expect(orderedEdgeLabel(undefined, 2)).toBe("2.");
    expect(orderedEdgeLabel("always", null)).toBe("always");
    expect(orderedEdgeLabel(undefined, null)).toBeUndefined();
  });
});

describe("formatInOutCounts", () => {
  test("formats as 'N in · M out'", () => {
    expect(formatInOutCounts({ inCount: 3, outCount: 1 })).toBe("3 in · 1 out");
    expect(formatInOutCounts({ inCount: 0, outCount: 0 })).toBe("0 in · 0 out");
  });
});

describe("kindLabel", () => {
  const base = { kind: "wait" as const };

  test("labels a wait node by what it waits for", () => {
    expect(kindLabel({ ...base, waitFor: "decision" })).toBe("Decision");
    expect(kindLabel(base)).toBe("Wait");
    expect(kindLabel({ ...base, waitFor: "reply" })).toBe("Wait · reply");
  });

  test("labels a step node with its step key", () => {
    expect(kindLabel({ kind: "step", stepKey: "triage" })).toBe(
      "Step · triage",
    );
    expect(kindLabel({ kind: "step" })).toBe("Step");
  });

  test("labels an event node with the work item its event is about", () => {
    expect(kindLabel({ kind: "event", event: "child.ready" })).toBe(
      "Event · child work item",
    );
    expect(kindLabel({ kind: "event", event: "self.attached" })).toBe(
      "Event · own work item",
    );
    expect(kindLabel({ kind: "event", event: "workItem.created" })).toBe(
      "Event · top-level work item",
    );
    expect(kindLabel({ kind: "event" })).toBe("Event");
  });

  test("labels a rule node with its 1-based number and event", () => {
    expect(
      kindLabel({ kind: "rule", ruleIndex: 1, event: "child.ready" }),
    ).toBe("Rule 2 · child.ready");
    expect(kindLabel({ kind: "rule" })).toBe("Rule");
  });

  test("labels a pipeline node with its key, subject and resolution", () => {
    expect(kindLabel({ kind: "pipeline", targetKey: "triage" })).toBe(
      "Pipeline · triage",
    );
    expect(
      kindLabel({ kind: "pipeline", targetKey: "triage", resolved: false }),
    ).toBe("Pipeline · triage (not found)");
    expect(
      kindLabel({ kind: "pipeline", targetKey: "triage", subject: "child" }),
    ).toBe("Pipeline · triage · on child");
  });

  test("labels an action node by what it does", () => {
    expect(
      kindLabel({
        kind: "action",
        actionKind: "step",
        targetKey: "plan",
        subject: "child",
      }),
    ).toBe("Step · plan · on child");
    expect(
      kindLabel({
        kind: "action",
        actionKind: "step",
        targetKey: "plan",
        subject: "workItem",
      }),
    ).toBe("Step · plan");
    expect(
      kindLabel({
        kind: "action",
        actionKind: "attach",
        targetKey: "wayfinder",
      }),
    ).toBe("Attach · wayfinder");
    expect(
      kindLabel({
        kind: "action",
        actionKind: "attach",
        targetKey: "wayfinder",
        resolved: false,
      }),
    ).toBe("Attach · wayfinder (not found)");
    expect(kindLabel({ kind: "action", actionKind: "skip" })).toBe("Skip");
    expect(kindLabel({ kind: "action" })).toBe("Action");
  });
});

describe("nodeLayoutSize", () => {
  test("draws an event as a pill and the other automation kinds as cards", () => {
    const card = nodeLayoutSize({ kind: "step" });
    const event = nodeLayoutSize({ kind: "event" });
    expect(event.height).toBeLessThan(card.height);
    expect(event.height).toBe(nodeLayoutSize({ kind: "succeed" }).height);
    for (const kind of ["rule", "pipeline", "action"] as const) {
      expect(nodeLayoutSize({ kind })).toEqual(card);
    }
  });

  test("adds a fork line to an all rule", () => {
    expect(nodeLayoutSize({ kind: "rule", match: "all" }).height).toBe(
      nodeLayoutSize({ kind: "rule" }).height + 16,
    );
  });
});

describe("edgeTone", () => {
  test("catch wins over a loop route", () => {
    expect(edgeTone({ kind: "catch", route: { kind: "loop", laneX: 0 } })).toBe(
      "catch",
    );
    expect(edgeTone({ kind: "route", route: { kind: "loop", laneX: 0 } })).toBe(
      "loop",
    );
    expect(edgeTone(undefined)).toBe("flow");
  });
});

describe("edgeLegendKinds", () => {
  test("always lists flow, plus each style present", () => {
    expect(edgeLegendKinds([])).toEqual(["flow"]);
    expect(
      edgeLegendKinds([
        { data: { kind: "catch" } },
        { data: { lane: "each" } },
        { data: { route: { kind: "loop", laneX: 0 } } },
      ]),
    ).toEqual(["flow", "loop", "catch", "each"]);
  });
});
