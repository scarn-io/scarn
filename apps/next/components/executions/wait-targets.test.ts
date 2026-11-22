import { describe, expect, test } from "bun:test";
import { waitNodeInfo } from "./wait-targets";

const onAction = (value: string, to: string) => ({
  when: { path: "result.action", op: "equal", value },
  to,
});

const documentWith = (node: Record<string, unknown>) => ({
  nodes: { gate: { kind: "wait", for: "decision", ...node } },
});

describe("waitNodeInfo", () => {
  test("maps each action to the route on result.action", () => {
    const info = waitNodeInfo(
      documentWith({
        title: "Ship it?",
        next: {
          routes: [onAction("approve", "deploy"), onAction("revise", "plan")],
          otherwise: { to: "stop" },
        },
      }),
      "gate",
    );

    expect(info.title).toBe("Ship it?");
    expect(info.targetOf("approve")).toBe("deploy");
    expect(info.targetOf("revise")).toBe("plan");
    expect(info.targetOf("reject")).toBe("stop");
  });

  test("a route with no condition always matches", () => {
    const info = waitNodeInfo(
      documentWith({ next: { routes: [{ to: "done" }] } }),
      "gate",
    );

    expect(info.targetOf("approve")).toBe("done");
    expect(info.targetOf()).toBe("done");
  });

  test("any other condition makes the target unknown", () => {
    const info = waitNodeInfo(
      documentWith({
        next: {
          routes: [
            { when: { path: "input.size", op: "gt", value: 3 }, to: "big" },
            onAction("approve", "deploy"),
          ],
        },
      }),
      "gate",
    );

    expect(info.targetOf("approve")).toBeNull();
  });

  test("a missing document or non-wait node knows nothing", () => {
    expect(waitNodeInfo(null, "gate").targetOf("approve")).toBeNull();
    expect(
      waitNodeInfo({ nodes: { gate: { kind: "succeed" } } }, "gate").title,
    ).toBeNull();
  });
});
