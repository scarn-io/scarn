import { describe, expect, test } from "bun:test";
import { colors } from "@scarn/design-tokens";
import type { StudioEdge, StudioNode } from "@scarn/pipeline-studio-ui";
import type { NodeVisualStatus } from "./pipeline-graph-node-status";
import {
  nodeDecorationForStatus,
  runDecorators,
} from "./pipeline-graph-run-decoration";

const UNREACHED: NodeVisualStatus = {
  label: null,
  colorKey: null,
  badgeLabel: null,
  traversed: false,
};

describe("nodeDecorationForStatus", () => {
  test("an unreached node is undecorated", () => {
    expect(nodeDecorationForStatus(UNREACHED)).toEqual({
      borderColor: null,
      badge: null,
      captionPrefix: null,
      tooltip: null,
      minimapColor: null,
    });
  });

  test("a running node gets a spinner and an accent border", () => {
    const decoration = nodeDecorationForStatus({
      label: "Running",
      colorKey: "primary",
      badgeLabel: null,
      traversed: true,
    });
    expect(decoration.borderColor).toBe(colors.accent);
    expect(decoration.badge).toEqual({ kind: "spinner", label: "Status: Running" });
  });

  test("lanes show their succeeded count; failure gets an error icon", () => {
    const decoration = nodeDecorationForStatus({
      label: "Failed",
      colorKey: "error",
      badgeLabel: "2/4 succeeded",
      traversed: true,
    });
    expect(decoration.captionPrefix).toBe("2/4 succeeded");
    expect(decoration.badge).toEqual({
      kind: "icon",
      icon: "statusError",
      color: colors.dangerFg,
      label: "Status: Failed",
    });
  });

  test("a cancelled node keeps its neutral border but shows on the minimap", () => {
    const decoration = nodeDecorationForStatus({
      label: "Cancelled",
      colorKey: "disabled",
      badgeLabel: null,
      traversed: true,
    });
    expect(decoration.borderColor).toBeNull();
    expect(decoration.minimapColor).toBe(colors.textDim);
  });
});

describe("runDecorators", () => {
  test("an edge is traversed when its target node was reached", () => {
    const calls: string[] = [];
    const { decorateEdge } = runDecorators((nodeId) => {
      calls.push(nodeId);
      return nodeId === "b" ? { ...UNREACHED, traversed: true } : UNREACHED;
    });
    const into = (target: string) =>
      ({ id: `e-${target}`, source: "a", target }) as StudioEdge;

    expect(decorateEdge(into("b")).strokeColor).toBe(colors.accent);
    expect(decorateEdge(into("c")).strokeColor).toBeUndefined();
    decorateEdge(into("b"));
    expect(calls).toEqual(["b", "c"]);
  });

  test("nodes are decorated from their own status", () => {
    const { decorateNode } = runDecorators(() => ({
      label: "Succeeded",
      colorKey: "success",
      badgeLabel: null,
      traversed: true,
    }));
    expect(decorateNode({ id: "a" } as StudioNode).borderColor).toBe(
      colors.successFg,
    );
  });
});
