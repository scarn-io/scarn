import { describe, expect, test } from "bun:test";
import { CLASSIFIED } from "./engine-fixtures-all";
import { refusal } from "./engine-fixtures-overrule";
import {
  classifiedRun,
  OTHERWISE,
  overridableTriage,
  pickedFork,
  route,
  splitLanes,
} from "./engine-fixtures-overrule-all";

const bug = { ...CLASSIFIED, category: "bug", duplicateCount: 0 };
const bugNoPages = { ...bug, affectedPages: [] };

describe("decide: overrules on match all", () => {
  test.concurrent("adding a lane leaves the running lanes alone", () => {
    const { run, visitId } = classifiedRun(bug);
    const reproduce = run.open("reproduce-in-browser");
    const capture = run.open("capture-screenshot", 0);
    run.overrule(visitId, [route(0), route(2), route(3)]);
    expect(run.cancelledTasks()).toEqual([]);
    expect(run.open("reproduce-in-browser")).toEqual(reproduce);
    expect(run.open("capture-screenshot", 0)).toEqual(capture);
    expect(run.open("link-duplicates").input).toEqual({ ids: ["d1"] });
    expect(run.state.laneGroups[0]?.laneCount).toBe(3);
    expect(splitLanes(run)[2]).toMatchObject({
      index: 2,
      origin: "split",
      route: route(3),
      status: "active",
    });
    expect(run.visits("classify-issue")[0]?.routing).toMatchObject({
      taken: [route(0), route(2), route(3)],
      overrules: [
        { from: [route(0), route(2)], to: [route(0), route(2), route(3)] },
      ],
    });
  });

  test.concurrent("removing a running lane cancels only that lane", () => {
    const { run, visitId } = classifiedRun();
    const duplicates = run.open("link-duplicates");
    const taskId = run.latestTaskId(duplicates.id);
    run.overrule(visitId, [route(0), route(1), route(2)]);
    expect(run.cancelledTasks()).toEqual([taskId]);
    expect(run.visits("link-duplicates")[0]?.status).toBe("superseded");
    expect(splitLanes(run)[3]?.status).toBe("cancelled");
    expect(run.state.laneGroups[0]?.laneCount).toBe(3);
    expect(run.open("reproduce-in-browser").status).toBe("active");
    expect(run.open("notify-security").status).toBe("active");
  });

  test.concurrent(
    "a lane added after a partial merge fired supersedes it, and it fires again",
    () => {
      const { run, visitId } = classifiedRun(bugNoPages);
      run.succeed("reproduce-in-browser", {
        reproduced: true,
        observedBehavior: "500 on pay",
      });
      const first = run.open("write-failing-test");
      run.overrule(visitId, [route(0), route(1)]);
      expect(run.visits("write-failing-test")[0]?.status).toBe("superseded");
      expect(run.visits("add-to-backlog")[0]?.status).toBe("superseded");
      expect(
        run.state.lanes.find((lane) => lane.id === first.laneId)?.status,
      ).toBe("cancelled");
      expect(splitLanes(run)[0]?.status).toBe("arrived");
      run.succeed("notify-security", { notified: true });
      expect(run.visits("write-failing-test", { status: "active" })).toEqual(
        [],
      );
      run.decide("security-sign-off", "approve", "no data leak");
      expect(run.open("write-failing-test").input).toEqual({
        observedBehavior: "500 on pay",
        securityNotes: "no data leak",
      });
    },
  );

  test.concurrent(
    "after the run finished: the closing merge and what followed run again",
    () => {
      const { run, visitId } = classifiedRun(bugNoPages);
      run.succeed("reproduce-in-browser", {
        reproduced: true,
        observedBehavior: "500 on pay",
      });
      run.succeed("add-to-backlog", { ok: true });
      run.succeed("write-failing-test", { testPath: "tests/pay.test.ts" });
      run.succeed("summarise", { urgent: false, text: "done" });
      run.succeed("open-pr", { ok: true });
      run.succeed("update-tracker", { ok: true });
      expect(run.state.run.status).toBe("succeeded");
      run.overrule(visitId, [route(0), route(1)]);
      expect(run.state.run).toMatchObject({
        status: "active",
        endNodeId: null,
      });
      expect(run.state.laneGroups[0]?.status).toBe("open");
      for (const node of ["write-failing-test", "summarise", "open-pr"]) {
        expect(run.visits(node).map((visit) => visit.status)).toEqual([
          "superseded",
        ]);
      }
      run.succeed("notify-security", { notified: true });
      run.decide("security-sign-off", "approve", "no data leak");
      run.succeed("write-failing-test", { testPath: "tests/again.test.ts" });
      expect(run.open("summarise").input).toEqual({
        failingTest: "tests/again.test.ts",
        screenshots: [],
      });
      run.succeed("summarise", { urgent: false, text: "again" });
      run.succeed("open-pr", { ok: true });
      run.succeed("update-tracker", { ok: true });
      expect(run.state.run.status).toBe("succeeded");
    },
  );

  test.concurrent(
    "removing the last lane a merge waited on fires it straight away",
    () => {
      const { run, visitId } = classifiedRun();
      run.succeed("reproduce-in-browser", {
        reproduced: true,
        observedBehavior: "500 on pay",
      });
      run.succeed("notify-security", { notified: true });
      run.overrule(visitId, [route(0), route(2), route(3)]);
      expect(run.visits("security-sign-off")[0]?.status).toBe("superseded");
      expect(run.open("write-failing-test").input).toEqual({
        observedBehavior: "500 on pay",
      });
    },
  );

  test.concurrent(
    "an added each route spawns its item lanes, which merge",
    () => {
      const { run, visitId } = classifiedRun(bug);
      run.overrule(visitId, [route(0), OTHERWISE]);
      expect(
        run.visits("capture-screenshot", { status: "superseded" }),
      ).toHaveLength(2);
      run.overrule(visitId, [route(0), route(2)]);
      expect(run.visits("add-to-backlog")[0]?.status).toBe("superseded");
      expect(run.open("capture-screenshot", 1).input).toEqual({ url: "/pay" });
      run.succeed("capture-screenshot", { url: "s/cart.png" }, { item: 0 });
      run.succeed("capture-screenshot", { url: "s/pay.png" }, { item: 1 });
      run.succeed("reproduce-in-browser", {
        reproduced: true,
        observedBehavior: "500 on pay",
      });
      run.succeed("write-failing-test", { testPath: "tests/pay.test.ts" });
      expect(run.open("summarise").input).toEqual({
        failingTest: "tests/pay.test.ts",
        screenshots: ["s/cart.png", "s/pay.png"],
      });
      expect(
        run
          .visits("classify-issue")[0]
          ?.routing?.overrules?.map((overrule) => overrule.from),
      ).toEqual([
        [route(0), route(2)],
        [route(0), OTHERWISE],
      ]);
    },
  );
});

describe("decide: overrules on match all, otherwise", () => {
  test.concurrent(
    "turning every conditional route off switches otherwise on",
    () => {
      const { run, visitId } = classifiedRun(bug);
      run.overrule(visitId, [route(0), OTHERWISE]);
      expect(run.open("add-to-backlog").input).toEqual({
        summary: "Checkout crashes",
      });
      expect(
        run.visits("capture-screenshot").map((visit) => visit.status),
      ).toEqual(["superseded", "superseded"]);
    },
  );

  test.concurrent("turning one on switches otherwise off", () => {
    const { run, visitId } = classifiedRun(bugNoPages);
    run.overrule(visitId, [route(0), route(3)]);
    expect(run.visits("add-to-backlog")[0]?.status).toBe("superseded");
    expect(run.open("link-duplicates").status).toBe("active");
  });

  test.concurrent("refused when otherwise isn't overridable", () => {
    const document = overridableTriage({ routes: [1, 2, 3], otherwise: false });
    const { run, visitId } = classifiedRun(bugNoPages, document);
    const error = refusal(() => run.overrule(visitId, [route(0), route(3)]));
    expect(error.code).toBe("route_not_overridable");
    expect(error.meta).toEqual({ routes: [OTHERWISE] });
  });

  test.concurrent("refused when otherwise disagrees with the rest", () => {
    const { run, visitId } = classifiedRun(bugNoPages);
    expect(
      refusal(() => run.overrule(visitId, [route(0), route(3), OTHERWISE]))
        .code,
    ).toBe("route_set_invalid");
    expect(refusal(() => run.overrule(visitId, [route(0)])).code).toBe(
      "route_set_invalid",
    );
  });
});

describe("decide: overrules on match all, refusals", () => {
  test.concurrent("a route without when left out of the set", () => {
    const { run, visitId } = classifiedRun();
    const error = refusal(() =>
      run.overrule(visitId, [route(1), route(2), route(3)]),
    );
    expect(error.code).toBe("route_set_invalid");
    expect(run.state.lanes.every((lane) => lane.status !== "cancelled")).toBe(
      true,
    );
  });

  test.concurrent("a route that isn't overridable", () => {
    const document = overridableTriage({ routes: [1], otherwise: true });
    const { run, visitId } = classifiedRun(CLASSIFIED, document);
    const error = refusal(() => run.overrule(visitId, [route(0), route(1)]));
    expect(error.code).toBe("route_not_overridable");
    expect(error.meta).toEqual({ routes: [route(2), route(3)] });
  });

  test.concurrent("a failed group", () => {
    const { run, visitId } = classifiedRun();
    run.succeed("reproduce-in-browser", {
      reproduced: false,
      observedBehavior: "fine",
    });
    expect(run.state.laneGroups[0]?.status).toBe("failed");
    expect(refusal(() => run.overrule(visitId, [route(0)])).code).toBe(
      "invalid_visit_state",
    );
  });
});

describe("decide: overrules on match all, lane counts", () => {
  test.concurrent(
    "turning every route off with no otherwise ends the lanes and the run",
    () => {
      const { run, visitId } = pickedFork(
        { merge: false, otherwise: false },
        { left: true, right: true },
      );
      run.overrule(visitId, []);
      expect(run.laneStatuses()).toEqual(["cancelled", "cancelled"]);
      expect(run.state.laneGroups[0]).toMatchObject({
        laneCount: 0,
        status: "merged",
      });
      expect(run.state.run).toMatchObject({
        status: "succeeded",
        endNodeId: "pick",
      });
    },
  );

  test.concurrent(
    "a lane added to a split that took no routes reopens the finished run",
    () => {
      const { run, visitId } = pickedFork(
        { merge: false, otherwise: false },
        { left: false, right: false },
      );
      expect(run.state.run.status).toBe("succeeded");
      run.overrule(visitId, [route(1)]);
      expect(run.state.run.status).toBe("active");
      expect(run.state.laneGroups[0]).toMatchObject({
        laneCount: 1,
        status: "open",
      });
      run.succeed("right", { v: "r" });
      expect(run.state.run).toMatchObject({
        status: "succeeded",
        endNodeId: null,
      });
    },
  );

  test.concurrent("percent toleratedFailures uses the new laneCount", () => {
    const { run, visitId } = classifiedRun();
    Object.assign(run.state.laneGroups[0] ?? {}, {
      toleratedFailures: { percent: 34 },
    });
    run.overrule(visitId, [route(0), route(2)]);
    expect(run.state.laneGroups[0]?.laneCount).toBe(2);
    run.succeed("reproduce-in-browser", {
      reproduced: false,
      observedBehavior: "fine",
    });
    expect(run.state.run).toMatchObject({
      status: "failed",
      error: { name: "Scarn.LanesFailed", message: "1 of 2 lanes failed" },
    });
  });
});
