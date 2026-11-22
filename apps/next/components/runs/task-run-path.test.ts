import { describe, expect, test } from "bun:test";
import { taskRunPath } from "./task-run-path";

const projectPath = (...segments: string[]) =>
  ["/alice/demo", ...segments].join("/");

describe("taskRunPath", () => {
  test("a standalone Task opens its own run page", () => {
    expect(taskRunPath(projectPath, { id: "t1", pipelineRunId: null })).toBe(
      "/alice/demo/runs/tasks/t1",
    );
  });

  test("a step's Task opens its pipeline run on that step", () => {
    expect(
      taskRunPath(projectPath, {
        id: "t1",
        pipelineRunId: "r1",
        nodeId: "fix",
      }),
    ).toBe("/alice/demo/runs/r1?step=fix");
  });

  test("a step's Task without a node opens the pipeline run", () => {
    expect(
      taskRunPath(projectPath, { id: "t1", pipelineRunId: "r1", nodeId: null }),
    ).toBe("/alice/demo/runs/r1");
  });
});
