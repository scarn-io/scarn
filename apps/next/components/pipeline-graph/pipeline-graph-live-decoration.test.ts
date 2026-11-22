import { describe, expect, test } from "bun:test";
import { EMPTY_NODE_DECORATION } from "@scarn/pipeline-studio-ui/view";
import type { StudioNode } from "@scarn/pipeline-studio-ui";
import { colors } from "@scarn/design-tokens";
import {
  formatNodeLiveCount,
  liveCountDecorator,
} from "./pipeline-graph-live-decoration";

const node = (id: string) => ({ id }) as StudioNode;

describe("liveCountDecorator", () => {
  test("formats the non-zero counts", () => {
    expect(
      formatNodeLiveCount({ running: 2, waiting: 0, failed: 1, lanes: 1 }),
    ).toBe("2 running · 1 failed · 1 lane");
  });

  test("badges open visits in the accent while any run", () => {
    const decorate = liveCountDecorator({
      review: { running: 1, waiting: 2, failed: 0, lanes: 3 },
    });
    expect(decorate(node("review"))).toMatchObject({
      borderColor: colors.accent,
      badge: { kind: "count", count: 3, color: colors.accent },
      captionSuffix: "1 running · 2 waiting · 3 lanes",
    });
  });

  test("greys a node where every visit waits, and reds one with only failures", () => {
    const decorate = liveCountDecorator({
      wait: { running: 0, waiting: 1, failed: 0, lanes: 0 },
      broke: { running: 0, waiting: 0, failed: 2, lanes: 0 },
    });
    expect(decorate(node("wait"))).toMatchObject({
      borderColor: null,
      badge: { count: 1, color: colors.textDim },
    });
    expect(decorate(node("broke"))).toMatchObject({
      borderColor: colors.dangerFg,
      badge: { count: 2, color: colors.dangerFg },
    });
  });

  test("leaves nodes without counts undecorated", () => {
    const decorate = liveCountDecorator({
      idle: { running: 0, waiting: 0, failed: 0, lanes: 0 },
    });
    expect(decorate(node("idle"))).toBe(EMPTY_NODE_DECORATION);
    expect(decorate(node("other"))).toBe(EMPTY_NODE_DECORATION);
  });
});
