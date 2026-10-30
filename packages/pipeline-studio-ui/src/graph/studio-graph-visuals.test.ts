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
  orderedEdgeLabel,
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
    expect(kindLabel({ kind: "step", stepKey: "triage" })).toBe("Step · triage");
    expect(kindLabel({ kind: "step" })).toBe("Step");
  });
});

describe("edgeTone", () => {
  test("catch wins over a loop route", () => {
    expect(edgeTone({ kind: "catch", route: { kind: "loop", laneX: 0 } })).toBe("catch");
    expect(edgeTone({ kind: "route", route: { kind: "loop", laneX: 0 } })).toBe("loop");
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
