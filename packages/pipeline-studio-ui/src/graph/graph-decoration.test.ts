import { describe, expect, test } from "bun:test";
import { colors } from "@scarn/design-tokens";
import {
  decorateEdgeWithIssues,
  decorateNodeWithIssues,
  edgeStroke,
} from "./graph-decoration";
import type {
  StudioEdge,
  StudioIssue,
  StudioNode,
} from "./studio-graph-types";

function issue(severity: StudioIssue["severity"]): StudioIssue {
  return { code: "x", severity, message: "m" };
}

function node(overrides: Partial<StudioNode["data"]> = {}): StudioNode {
  return {
    id: "n",
    position: { x: 0, y: 0 },
    data: { label: "n", kind: "step", issues: [], shape: { kind: "none" }, ...overrides },
  };
}

function edge(data: Partial<NonNullable<StudioEdge["data"]>> = {}): StudioEdge {
  return {
    id: "e",
    source: "a",
    target: "b",
    data: { kind: "route", index: 0, lane: null, order: null, issues: [], ...data },
  };
}

describe("decorateNodeWithIssues", () => {
  test("a node without issues is undecorated", () => {
    expect(decorateNodeWithIssues(node())).toEqual({
      borderColor: null,
      badge: null,
      captionSuffix: null,
    });
  });

  test("the highest severity colors the border and a count badge", () => {
    const decoration = decorateNodeWithIssues(
      node({ issues: [issue("warning"), issue("error")] }),
    );
    expect(decoration.borderColor).toBe(colors.dangerFg);
    expect(decoration.badge).toEqual({
      kind: "count",
      count: 2,
      color: colors.dangerFg,
      label: "2 validation issue(s)",
    });
  });

  test("a step with known schemas shows its field counts", () => {
    const decoration = decorateNodeWithIssues(
      node({
        shape: {
          kind: "step",
          inputFields: [{ name: "a", type: "string", required: true }],
          resultFields: [],
          resultSchemaJson: {},
          errors: [],
        },
      }),
    );
    expect(decoration.captionSuffix).toBe("1 in · 0 out");
  });
});

describe("decorateEdgeWithIssues / edgeStroke", () => {
  test("an edge without issues keeps its tone color", () => {
    const plain = edge();
    expect(edgeStroke(plain, decorateEdgeWithIssues(plain))).toBe(colors.borderStrong);
    const caught = edge({ kind: "catch" });
    expect(edgeStroke(caught, decorateEdgeWithIssues(caught))).toBe(colors.dangerFg);
  });

  test("an edge with issues is drawn emphasized in its severity color", () => {
    const flagged = edge({ issues: [issue("warning")] });
    const decoration = decorateEdgeWithIssues(flagged);
    expect(decoration.emphasized).toBe(true);
    expect(edgeStroke(flagged, decoration)).toBe(colors.attentionFg);
  });
});
