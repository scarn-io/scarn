import { describe, expect, test } from "bun:test";
import { projectId, workItemId } from "./tasks-test-support";

const { buildStartTaskInput, latestStepDefinitions } =
  await import("./start-task-dialog");

const stepDefinitionId = "019e9a92-b432-73e8-9341-3519156fa600";

describe("buildStartTaskInput", () => {
  const base = { projectId, workItemId, stepDefinition: null, prompt: "" };

  test("sends the step definition and its version in step mode", () => {
    expect(
      buildStartTaskInput({
        ...base,
        mode: "step",
        stepDefinition: { id: stepDefinitionId, version: 4 },
      }),
    ).toEqual({
      projectId,
      workItemId,
      stepDefinitionId,
      stepDefinitionVersion: 4,
    });
    expect(buildStartTaskInput({ ...base, mode: "step" })).toBeNull();
  });

  test("sends the trimmed prompt in prompt mode", () => {
    expect(
      buildStartTaskInput({
        ...base,
        mode: "prompt",
        prompt: "  Write the release notes  ",
      }),
    ).toEqual({
      projectId,
      workItemId,
      prompt: "Write the release notes",
      repoWrite: false,
    });
    expect(
      buildStartTaskInput({
        ...base,
        mode: "prompt",
        prompt: "Fix it",
        repoWrite: true,
      }),
    ).toEqual({ projectId, workItemId, prompt: "Fix it", repoWrite: true });
    expect(
      buildStartTaskInput({
        ...base,
        mode: "prompt",
        prompt: "Go",
        environment: { name: "staging" },
      }),
    ).toEqual({
      projectId,
      workItemId,
      prompt: "Go",
      repoWrite: false,
      environment: { name: "staging" },
    });
    expect(
      buildStartTaskInput({
        ...base,
        mode: "prompt",
        prompt: "Go",
        environment: null,
      }),
    ).toBeNull();
    expect(
      buildStartTaskInput({ ...base, mode: "prompt", prompt: "   " }),
    ).toBeNull();
  });
});

describe("latestStepDefinitions", () => {
  test("keeps the highest version of each definition, sorted by name", () => {
    const result = latestStepDefinitions([
      { id: "b", name: "Review", version: 1 },
      { id: "a", name: "Implement", version: 1 },
      { id: "a", name: "Implement", version: 3 },
    ]);
    expect(result.map((d) => [d.id, d.version])).toEqual([
      ["a", 3],
      ["b", 1],
    ]);
  });
});
