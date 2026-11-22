import { describe, expect, test } from "bun:test";
import type { StepCatalog } from "@scarn/sdk/contracts/pipeline-document";
import { RunSimulator } from "./engine-harness";
import { obj } from "./engine-fixture-schema";

const strings = { type: "array", items: { type: "string" } } as const;

const nestedSteps: StepCatalog = {
  modules: {
    inputSchema: obj("ModulesInput", { request: { type: "string" } }),
    resultSchema: obj("ModulesResult", { modules: strings }),
    errors: [],
  },
  files: {
    inputSchema: obj("FilesInput", { module: { type: "string" } }),
    resultSchema: obj("FilesResult", { files: strings }),
    errors: [],
  },
  edit: {
    inputSchema: obj("EditInput", { file: { type: "string" } }),
    resultSchema: obj("EditResult", { file: { type: "string" } }),
    errors: [],
  },
  summarize: {
    inputSchema: obj("SummarizeInput", {
      edits: { type: "array", items: obj("E", { file: { type: "string" } }) },
    }),
    resultSchema: obj("SummarizeResult", { text: { type: "string" } }),
    errors: [],
  },
  publish: {
    inputSchema: obj("PublishInput", {
      summaries: {
        type: "array",
        items: obj("S", { text: { type: "string" } }),
      },
    }),
    resultSchema: obj("PublishResult", { ok: { type: "boolean" } }),
    errors: [],
  },
};

const nestedPipeline = {
  schemaVersion: 1,
  key: "nested",
  start: { to: "modules", args: { request: "workItem.title" } },
  nodes: {
    modules: {
      kind: "step",
      step: "modules",
      next: {
        routes: [
          {
            to: "files",
            each: { over: "result.modules" },
            args: { module: "item" },
          },
        ],
      },
    },
    files: {
      kind: "step",
      step: "files",
      next: {
        routes: [
          {
            to: "edit",
            each: { over: "result.files" },
            args: { file: "item" },
          },
        ],
      },
    },
    edit: {
      kind: "step",
      step: "edit",
      next: {
        routes: [
          {
            to: "summarize",
            args: { edits: { list: ["result"] } },
            partial: true,
          },
        ],
      },
    },
    summarize: {
      kind: "step",
      step: "summarize",
      next: {
        routes: [
          {
            to: "publish",
            args: { summaries: { list: ["result"] } },
            partial: true,
          },
        ],
      },
    },
    publish: {
      kind: "step",
      step: "publish",
      next: {
        routes: [{ to: "done" }],
      },
    },
    done: { kind: "succeed" },
  },
};

/** Both splits close at one merge: the inner merge carries each module's edits up as its outer lane's arrival. */
const cascadingPipeline = {
  ...nestedPipeline,
  key: "cascading",
  nodes: {
    modules: nestedPipeline.nodes.modules,
    files: nestedPipeline.nodes.files,
    edit: {
      kind: "step",
      step: "edit",
      next: {
        routes: [
          {
            to: "summarize",
            args: { edits: { list: ["result"] } },
            partial: true,
          },
        ],
      },
    },
    summarize: {
      kind: "step",
      step: "summarize",
      next: { routes: [{ to: "done" }] },
    },
    done: { kind: "succeed" },
  },
};

function nestedRun(document: object = nestedPipeline) {
  const run = new RunSimulator(document, nestedSteps).start();
  run.succeed("modules", { modules: ["m0", "m1"] });
  for (const item of [0, 1]) {
    run.succeed("files", { files: [`m${String(item)}/a`] }, { item });
  }
  return run;
}

function editVisit(run: RunSimulator, file: string) {
  const visit = run.state.visits.find(
    (entry) =>
      entry.nodeId === "edit" &&
      entry.input["file"] === file &&
      entry.status === "active",
  );
  if (visit === undefined) {
    throw new Error(`no open edit for ${file}`);
  }
  return visit;
}

function finishEdit(run: RunSimulator, file: string) {
  run.succeedTask(run.latestTaskId(editVisit(run, file).id), { file });
}

describe("decide: nested lanes", () => {
  test.concurrent(
    "inner merges run on the outer lane, and the outer merge collects them",
    () => {
      const run = nestedRun();
      expect(run.state.laneGroups).toHaveLength(3);
      finishEdit(run, "m0/a");
      const summarize = run.state.visits.find((v) => v.nodeId === "summarize");
      expect(summarize?.input).toEqual({ edits: [{ file: "m0/a" }] });
      expect(run.itemOf(summarize as never)).toBe(0);
      finishEdit(run, "m1/a");
      run.succeed("summarize", { text: "zero" }, { item: 0 });
      run.succeed("summarize", { text: "one" }, { item: 1 });
      expect(run.open("publish").input).toEqual({
        summaries: [{ text: "zero" }, { text: "one" }],
      });
    },
  );

  test.concurrent(
    "rerunning an inner lane after both merges reopens the groups outward",
    () => {
      const run = nestedRun();
      finishEdit(run, "m0/a");
      finishEdit(run, "m1/a");
      run.succeed("summarize", { text: "zero" }, { item: 0 });
      run.succeed("summarize", { text: "one" }, { item: 1 });
      const publish = run.open("publish");
      const edit = run.state.visits.find(
        (entry) => entry.nodeId === "edit" && entry.input["file"] === "m0/a",
      );
      run.rerun(edit?.id as string);
      expect(run.state.visits.find((v) => v.id === publish.id)?.status).toBe(
        "superseded",
      );
      expect(run.state.laneGroups.map((group) => group.status)).toEqual([
        "open",
        "open",
        "merged",
      ]);
      finishEdit(run, "m0/a");
      run.succeed("summarize", { text: "zero again" }, { item: 0 });
      expect(run.open("publish").input).toEqual({
        summaries: [{ text: "zero again" }, { text: "one" }],
      });
      run.succeed("publish", { ok: true });
      expect(run.state.run.status).toBe("succeeded");
    },
  );

  test.concurrent(
    "a merge two levels deep closes both splits and concatenates in parent-lane order",
    () => {
      const run = new RunSimulator(cascadingPipeline, nestedSteps).start();
      run.succeed("modules", { modules: ["m0", "m1"] });
      run.succeed("files", { files: ["m1/a", "m1/b"] }, { item: 1 });
      run.succeed("files", { files: ["m0/a"] }, { item: 0 });
      finishEdit(run, "m1/b");
      finishEdit(run, "m1/a");
      expect(run.visits("summarize")).toEqual([]);
      const outerLanes = run.state.lanes.filter(
        (lane) => lane.laneGroupId === run.state.laneGroups[0]?.id,
      );
      expect(outerLanes.map((lane) => lane.status)).toEqual([
        "active",
        "arrived",
      ]);
      expect(outerLanes[1]).toMatchObject({
        arrivedAtNodeId: "summarize",
        arrivalArgs: { edits: [{ file: "m1/a" }, { file: "m1/b" }] },
        arrivedFromVisitId: null,
      });
      finishEdit(run, "m0/a");
      const summarize = run.open("summarize");
      expect(summarize).toMatchObject({
        laneId: null,
        transition: { kind: "merge", index: 0 },
      });
      expect(summarize.input).toEqual({
        edits: [{ file: "m0/a" }, { file: "m1/a" }, { file: "m1/b" }],
      });
      expect(run.state.laneGroups.map((group) => group.status)).toEqual([
        "merged",
        "merged",
        "merged",
      ]);
      expect(
        run.state.lanes
          .filter((lane) => lane.arrivedFromVisitId !== null)
          .map((lane) => lane.mergedIntoVisitId),
      ).toEqual([summarize.id, summarize.id, summarize.id]);
      run.succeed("summarize", { text: "all" });
      expect(run.state.run.status).toBe("succeeded");
    },
  );

  test.concurrent(
    "rerunning inside a group a cascading merge closed reopens every closed group",
    () => {
      const run = nestedRun(cascadingPipeline);
      finishEdit(run, "m0/a");
      finishEdit(run, "m1/a");
      const first = run.open("summarize");
      const edit = run.state.visits.find(
        (entry) => entry.nodeId === "edit" && entry.input["file"] === "m1/a",
      );
      run.rerun(edit?.id as string);
      expect(run.state.visits.find((v) => v.id === first.id)?.status).toBe(
        "superseded",
      );
      expect(run.state.laneGroups.map((group) => group.status)).toEqual([
        "open",
        "merged",
        "open",
      ]);
      finishEdit(run, "m1/a");
      expect(run.open("summarize").input).toEqual({
        edits: [{ file: "m0/a" }, { file: "m1/a" }],
      });
    },
  );
});
