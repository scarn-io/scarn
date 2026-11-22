import { describe, expect, test } from "bun:test";
import {
  CLASSIFIED,
  forkDocument,
  forkSteps,
  triageDocument,
  triageRun,
} from "./engine-fixtures-all";
import { RunSimulator } from "./engine-harness";

function lanesOfGroup(run: RunSimulator, index: number) {
  const group = run.state.laneGroups[index];
  return run.state.lanes
    .filter((lane) => lane.laneGroupId === group?.id)
    .sort((left, right) => left.index - right.index);
}

/** Runs the triage example up to the summarise merge, leaving link-duplicates running. */
function toSummarise(run: RunSimulator) {
  run.succeed("reproduce-in-browser", {
    reproduced: true,
    observedBehavior: "500 on pay",
  });
  run.succeed("notify-security", { notified: true });
  run.decide("security-sign-off", "approve", "no data leak");
  run.succeed("capture-screenshot", { url: "s/cart.png" }, { item: 0 });
  run.succeed("capture-screenshot", { url: "s/pay.png" }, { item: 1 });
  run.succeed("write-failing-test", { testPath: "tests/pay.test.ts" });
}

describe("decide: match all", () => {
  test.concurrent("every matching route starts a lane of one group", () => {
    const run = triageRun();
    const [all, each] = run.state.laneGroups;
    expect(all).toMatchObject({
      kind: "all",
      laneCount: 4,
      toleratedFailures: { count: 0 },
      maxConcurrency: null,
    });
    expect(lanesOfGroup(run, 0).map((lane) => [lane.route, lane.item])).toEqual(
      [
        [{ kind: "route", index: 0 }, null],
        [{ kind: "route", index: 1 }, null],
        [{ kind: "route", index: 2 }, null],
        [{ kind: "route", index: 3 }, null],
      ],
    );
    expect(each).toMatchObject({
      kind: "each",
      laneCount: 2,
      maxConcurrency: 3,
      parentLaneId: lanesOfGroup(run, 0)[2]?.id,
    });
    expect(run.open("capture-screenshot", 1).input).toEqual({ url: "/pay" });
    expect(run.open("link-duplicates").input).toEqual({ ids: ["d1"] });
    expect(run.visits("add-to-backlog")).toEqual([]);
  });

  test.concurrent(
    "a partial merge continues as one lane; the closing merge cascades",
    () => {
      const run = triageRun();
      run.succeed("reproduce-in-browser", {
        reproduced: true,
        observedBehavior: "500 on pay",
      });
      expect(run.visits("write-failing-test")).toEqual([]);
      run.succeed("notify-security", { notified: true });
      run.decide("security-sign-off", "approve", "no data leak");
      const partial = run.open("write-failing-test");
      expect(partial.input).toEqual({
        observedBehavior: "500 on pay",
        securityNotes: "no data leak",
      });
      expect(lanesOfGroup(run, 0)[4]).toMatchObject({
        id: partial.laneId,
        index: 4,
        origin: "merge",
        route: { kind: "merge", index: 0 },
      });
      run.succeed("capture-screenshot", { url: "s/cart.png" }, { item: 0 });
      run.succeed("capture-screenshot", { url: "s/pay.png" }, { item: 1 });
      expect(run.visits("summarise")).toEqual([]);
      run.succeed("write-failing-test", { testPath: "tests/pay.test.ts" });
      const summarise = run.open("summarise");
      expect(summarise).toMatchObject({
        laneId: null,
        fromLaneGroupId: run.state.laneGroups[0]?.id,
      });
      expect(summarise.input).toEqual({
        failingTest: "tests/pay.test.ts",
        screenshots: ["s/cart.png", "s/pay.png"],
      });
      expect(run.state.laneGroups.map((group) => group.status)).toEqual([
        "merged",
        "merged",
      ]);
    },
  );

  test.concurrent(
    "fire-and-forget lanes outlive the closing merge, and the run waits for them",
    () => {
      const run = triageRun();
      toSummarise(run);
      run.succeed("summarise", { urgent: false, text: "done" });
      expect(run.open("link-duplicates").status).toBe("active");
      run.succeed("open-pr", { ok: true });
      run.succeed("update-tracker", { ok: true });
      expect(run.visits("post-to-slack")).toEqual([]);
      expect(run.state.run.status).toBe("active");
      run.succeed("link-duplicates", { linked: 1 });
      expect(run.state.run).toMatchObject({
        status: "succeeded",
        endNodeId: null,
      });
    },
  );

  test.concurrent(
    "an item field whose route wasn't taken merges as [], and otherwise still runs",
    () => {
      const run = triageRun({
        ...CLASSIFIED,
        category: "bug",
        affectedPages: [],
        duplicateCount: 0,
      });
      expect(run.state.lanes.map((lane) => lane.route)).toEqual([
        { kind: "route", index: 0 },
        { kind: "otherwise", index: 0 },
      ]);
      run.succeed("reproduce-in-browser", {
        reproduced: true,
        observedBehavior: "500 on pay",
      });
      expect(run.open("write-failing-test").input).toEqual({
        observedBehavior: "500 on pay",
      });
      run.succeed("write-failing-test", { testPath: "tests/pay.test.ts" });
      expect(run.open("summarise").input).toEqual({
        failingTest: "tests/pay.test.ts",
        screenshots: [],
      });
      expect(run.open("add-to-backlog").input).toEqual({
        summary: "Checkout crashes",
      });
    },
  );

  test.concurrent("a lane failure in an all split fails the run", () => {
    const run = triageRun();
    run.succeed("reproduce-in-browser", {
      reproduced: false,
      observedBehavior: "fine",
    });
    expect(run.state.run).toMatchObject({
      status: "failed",
      error: { name: "Scarn.LanesFailed", message: "1 of 4 lanes failed" },
    });
    expect(run.open.bind(run, "link-duplicates")).toThrow();
    expect(run.visits("link-duplicates")[0]?.status).toBe("cancelled");
  });

  test.concurrent(
    "a failure inside an item lane counts against the item tolerance",
    () => {
      const document = triageDocument() as {
        nodes: Record<string, { next?: { routes: Record<string, unknown>[] } }>;
      };
      const route = document.nodes["classify-issue"]?.next?.routes[2] as {
        each: Record<string, unknown>;
      };
      route.each["toleratedFailures"] = { count: 1 };
      const run = triageRun(CLASSIFIED, document);
      run.fail("capture-screenshot", { item: 0 });
      run.succeed("capture-screenshot", { url: "s/pay.png" }, { item: 1 });
      expect(run.state.run.status).toBe("active");
      expect(lanesOfGroup(run, 0)[2]).toMatchObject({
        status: "arrived",
        arrivalArgs: { screenshots: ["s/pay.png"] },
      });
    },
  );

  test.concurrent("rerunning an all lane after the merge", () => {
    const run = triageRun();
    toSummarise(run);
    const first = run.open("summarise");
    const reproduce = run.visits("reproduce-in-browser")[0];
    run.rerun(reproduce?.id as string);
    expect(run.visits("summarise")[0]?.status).toBe("superseded");
    expect(run.visits("write-failing-test")[0]?.status).toBe("superseded");
    expect(lanesOfGroup(run, 0).map((lane) => lane.status)).toEqual([
      "active",
      "arrived",
      "arrived",
      "active",
      "cancelled",
    ]);
    run.succeed("reproduce-in-browser", {
      reproduced: true,
      observedBehavior: "still 500",
    });
    expect(run.open("write-failing-test").input).toEqual({
      observedBehavior: "still 500",
      securityNotes: "no data leak",
    });
    expect(lanesOfGroup(run, 0)[5]).toMatchObject({
      index: 5,
      origin: "merge",
      status: "active",
    });
    run.succeed("write-failing-test", { testPath: "tests/again.test.ts" });
    const again = run.open("summarise");
    expect(again.id).not.toBe(first.id);
    expect(again.input).toEqual({
      failingTest: "tests/again.test.ts",
      screenshots: ["s/cart.png", "s/pay.png"],
    });
  });
});

describe("decide: match all with no routes taken", () => {
  test.concurrent("no otherwise and no merge: the run ends at the node", () => {
    const run = new RunSimulator(
      forkDocument({ merge: false, otherwise: false }),
      forkSteps,
    ).start();
    run.succeed("pick", { left: false, right: false });
    expect(run.state.laneGroups[0]).toMatchObject({
      kind: "all",
      laneCount: 0,
      status: "merged",
    });
    expect(run.visits("pick")[0]?.routing?.taken).toEqual([]);
    expect(run.state.run).toMatchObject({
      status: "succeeded",
      endNodeId: "pick",
    });
  });

  test.concurrent("no otherwise with a merge: the merge fires empty", () => {
    const run = new RunSimulator(
      forkDocument({ merge: true, otherwise: false }),
      forkSteps,
    ).start();
    run.succeed("pick", { left: false, right: false });
    expect(run.open("collect").input).toEqual({});
    run.succeed("collect", {});
    expect(run.state.run).toMatchObject({
      status: "succeeded",
      endNodeId: "done",
    });
  });

  test.concurrent("otherwise and no merge: the otherwise lane runs", () => {
    const run = new RunSimulator(
      forkDocument({ merge: false, otherwise: true }),
      forkSteps,
    ).start();
    run.succeed("pick", { left: false, right: false });
    expect(run.state.lanes[0]?.route).toEqual({ kind: "otherwise", index: 0 });
    run.succeed("fallback", {});
    expect(run.state.run).toMatchObject({
      status: "succeeded",
      endNodeId: null,
    });
  });

  test.concurrent(
    "otherwise is skipped when a conditional route matched",
    () => {
      const run = new RunSimulator(
        forkDocument({ merge: true, otherwise: true }),
        forkSteps,
      ).start();
      run.succeed("pick", { left: true, right: true });
      expect(run.state.lanes.map((lane) => lane.route.index)).toEqual([0, 1]);
      run.succeed("right", { v: "r" });
      run.succeed("left", { v: "l" });
      expect(run.open("collect").input).toEqual({ left: "l", right: "r" });
    },
  );

  test.concurrent(
    "a succeed node shared by an all lane and the top level",
    () => {
      const run = new RunSimulator(
        forkDocument({ merge: true, otherwise: true }),
        forkSteps,
      ).start();
      run.succeed("pick", { left: false, right: false });
      expect(run.open("collect").input).toEqual({});
      run.succeed("collect", {});
      expect(run.visits("done")).toHaveLength(1);
      expect(run.state.run.status).toBe("active");
      run.succeed("fallback", {});
      expect(run.visits("done").map((visit) => visit.laneId !== null)).toEqual([
        false,
        true,
      ]);
      expect(run.state.run).toMatchObject({
        status: "succeeded",
        endNodeId: "done",
      });
    },
  );
});
