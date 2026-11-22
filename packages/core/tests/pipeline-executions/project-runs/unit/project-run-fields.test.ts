import { describe, expect, test } from "bun:test";
import { createUuidV7 } from "@/common/contracts/uuid-v7";
import {
  conversationTaskStatusLine,
  conversationTaskTitle,
  projectRunHref,
  standaloneTaskOutcome,
  standaloneTaskTitle,
  standaloneTaskType,
  standaloneTaskWhatRan,
} from "@/pipeline-executions/project-runs/application/project-run-fields";

const id = createUuidV7();
const step = { id: createUuidV7(), name: "Triage" };

describe("projectRunHref", () => {
  test("links each kind under runs/", () => {
    expect(projectRunHref("pipeline", id)).toBe(`runs/${id}`);
    expect(projectRunHref("step", id)).toBe(`runs/tasks/${id}`);
    expect(projectRunHref("task", id)).toBe(`runs/tasks/${id}`);
  });
});

describe("standalone Tasks", () => {
  test("a step Task is a step, titled by its work item", () => {
    const task = {
      stepDefinition: step,
      prompt: "Triage the bug",
      workItemTitle: "Login breaks",
    };
    expect(standaloneTaskType(task)).toBe("step");
    expect(standaloneTaskWhatRan(task)).toEqual({ kind: "step", ...step });
    expect(standaloneTaskTitle(task)).toBe("Login breaks");
  });

  test("a prompt Task is titled by its prompt's first line", () => {
    const task = {
      stepDefinition: null,
      prompt: "\n  Fix   the login\nIt breaks on Safari",
      workItemTitle: "Login breaks",
    };
    expect(standaloneTaskType(task)).toBe("task");
    expect(standaloneTaskWhatRan(task)).toEqual({ kind: "task", name: "Task" });
    expect(standaloneTaskTitle(task)).toBe("Fix the login");
  });

  test("a blank prompt or a code Task falls back to the work item title", () => {
    expect(
      standaloneTaskTitle({
        stepDefinition: null,
        prompt: "  \n ",
        workItemTitle: "Login breaks",
      }),
    ).toBe("Login breaks");
    expect(
      standaloneTaskTitle({
        stepDefinition: null,
        prompt: null,
        workItemTitle: "Login breaks",
      }),
    ).toBe("Login breaks");
  });

  test("a failed Task's outcome is its latest run's error name", () => {
    expect(
      standaloneTaskOutcome({
        status: "failed",
        latestRun: { status: "failed", errorJson: { name: "Custom.Error" } },
      }),
    ).toBe("Custom.Error");
    expect(
      standaloneTaskOutcome({
        status: "failed",
        latestRun: { status: "timeout", errorJson: null },
      }),
    ).toBe("Scarn.Timeout");
    expect(standaloneTaskOutcome({ status: "failed", latestRun: null })).toBe(
      "Scarn.StepFailed",
    );
  });

  test("any other Task has no outcome", () => {
    expect(
      standaloneTaskOutcome({
        status: "succeeded",
        latestRun: { status: "failed", errorJson: { name: "X" } },
      }),
    ).toBeNull();
  });
});

describe("Tasks without a work item", () => {
  test("are titled by their first message and lined by the agent's last", () => {
    expect(conversationTaskTitle("  How does\nauth work?  ")).toBe(
      "How does auth work?",
    );
    expect(conversationTaskStatusLine("It uses\n\nJWTs.")).toBe(
      "It uses JWTs.",
    );
    expect(conversationTaskStatusLine(null)).toBe("");
  });
});
