import { describe, expect, test } from "bun:test";
import { createUuidV7 } from "@/common/contracts/uuid-v7";
import { CoreValidationError } from "@/lib/errors";
import { StepDefinitionEntity } from "@/pipeline-definitions/step-definition/domain/step-definition-entity";
import { stepDefinitionTaskSpec } from "@/tasks/task/application/start-task-from-step-definition";
import {
  DEFAULT_STANDALONE_MAX_TURNS,
  turnsLeft,
} from "@/tasks/task/domain/task-turns";
import { buildTask, LATER } from "./on-run-ended-fixtures";

const stepDefinition = (maxTurns?: number | null) =>
  StepDefinitionEntity.create({
    projectId: createUuidV7(),
    key: "chat",
    name: "Chat",
    description: null,
    prompt: "Talk it through.",
    version: 1,
    kind: "user_defined",
    inputSchemaJson: { type: "object" },
    resultSchemaJson: null,
    maxTurns,
    taskExecutionConfigId: null,
    status: "active",
  });

describe("standalone Task turns", () => {
  test.concurrent("a standalone Task copies its step's maxTurns", () => {
    expect(stepDefinitionTaskSpec(stepDefinition(3)).maxTurns).toBe(3);
  });

  test.concurrent.each([[undefined], [null]])(
    "a step with maxTurns %p gives its Tasks the default",
    (maxTurns) => {
      expect(stepDefinitionTaskSpec(stepDefinition(maxTurns)).maxTurns).toBe(
        DEFAULT_STANDALONE_MAX_TURNS,
      );
      expect(DEFAULT_STANDALONE_MAX_TURNS).toBe(20);
    },
  );

  test.concurrent.each([[0], [-1], [1.5]])(
    "a step definition refuses maxTurns %p",
    (maxTurns) => {
      try {
        stepDefinition(maxTurns);
        throw new Error("Expected a validation error");
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(CoreValidationError);
        expect((error as CoreValidationError).code).toBe(
          "STEP_DEFINITION_MAX_TURNS_INVALID",
        );
      }
    },
  );
});

describe("TaskEntity.grantTurn", () => {
  test.concurrent(
    "with no turns left it raises maxTurns so one is left",
    () => {
      const task = buildTask("waiting_for_person", 1);

      const granted = task.grantTurn(2, LATER);

      expect(granted.maxTurns).toBe(3);
      expect(turnsLeft(granted, 2)).toBe(1);
      expect(granted.updatedAt).toEqual(LATER);
    },
  );

  test.concurrent("with turns left it changes nothing", () => {
    const task = buildTask("waiting_for_person", 5);

    expect(task.grantTurn(2, LATER)).toBe(task);
  });

  test.concurrent("a Task with no maxTurns changes nothing", () => {
    const task = buildTask("waiting_for_person", null);

    expect(task.grantTurn(4, LATER)).toBe(task);
  });
});
