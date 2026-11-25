import { describe, expect } from "bun:test";
import { createUuidV7 } from "@/common/contracts/uuid-v7";
import { CoreValidationError } from "@/lib/errors";
import { createStepDefinitionInputSchema } from "@/pipeline-definitions/step-definition/contracts/step-definition-contracts";
import {
  StepDefinitionEntity,
  type CreateStepDefinitionEntityProps,
} from "@/pipeline-definitions/step-definition/domain/step-definition-entity";
import type { Grant } from "@/tasks/task/domain/grants";
import { concurrentTest } from "tests/utils";

const READ_PROJECT: Grant = {
  resource: "workItem",
  action: "read",
  scope: "project",
};
const CREATE_PROJECT: Grant = {
  resource: "workItem",
  action: "create",
  scope: "project",
  labels: ["acme"],
  keyPrefix: "acme:",
};
const UPDATE_PROJECT: Grant = {
  resource: "workItem",
  action: "update",
  scope: "project",
  keyPrefix: "acme:",
};

const codeInput = (grants: Grant[]) => ({
  projectId: "019a0000-0000-7000-8000-000000000000",
  key: "import-acme",
  name: "Import Acme",
  description: null,
  prompt: null,
  version: 1,
  kind: "code" as const,
  entrypointJson: { sourceFile: ".scarn/import.ts" },
  inputSchemaJson: { type: "object" },
  resultSchemaJson: { type: "object" },
  grants,
  status: "active" as const,
});

const agentInput = (grants: Grant[]) => ({
  ...codeInput(grants),
  kind: "user_defined" as const,
  prompt: "Triage it.",
  entrypointJson: null,
});

const grantIssues = (input: Record<string, unknown>) => {
  const result = createStepDefinitionInputSchema.safeParse(input);
  return (result.error?.issues ?? []).filter(
    (issue) => issue.path[0] === "grants",
  );
};

const entityProps = (
  kind: "code" | "user_defined",
  grants: Grant[],
): CreateStepDefinitionEntityProps => ({
  projectId: createUuidV7(),
  key: "import-acme",
  name: "Import Acme",
  prompt: kind === "code" ? null : "Triage it.",
  version: 1,
  kind,
  entrypointJson: kind === "code" ? { sourceFile: ".scarn/import.ts" } : null,
  inputSchemaJson: { type: "object" },
  resultSchemaJson: { type: "object" },
  taskExecutionConfigId: createUuidV7(),
  grants,
  status: "active",
});

const expectGrantsInvalid = (fn: () => void) => {
  try {
    fn();
    throw new Error("expected a CoreValidationError");
  } catch (error) {
    expect(error).toBeInstanceOf(CoreValidationError);
    expect((error as CoreValidationError).code).toBe(
      "STEP_DEFINITION_GRANTS_INVALID",
    );
  }
};

describe("step definition grants by kind: contracts", () => {
  concurrentTest(
    "a code step may hold read, create and update on project",
    () => {
      expect(
        grantIssues(codeInput([READ_PROJECT, CREATE_PROJECT, UPDATE_PROJECT])),
      ).toEqual([]);
    },
  );

  concurrentTest.each([
    ["read on self", { resource: "workItem", action: "read", scope: "self" }],
    [
      "update on self",
      { resource: "workItem", action: "update", scope: "self" },
    ],
    [
      "create on children",
      {
        resource: "workItem",
        action: "create",
        scope: "children",
        labels: ["a"],
      },
    ],
    [
      "comment on children",
      { resource: "workItem", action: "comment", scope: "children" },
    ],
  ] as const)("a code step may not hold %s", (_label, grant) => {
    expect(grantIssues(codeInput([grant as Grant]))).toHaveLength(1);
  });

  concurrentTest("an agent step may not hold update on project", () => {
    expect(grantIssues(agentInput([UPDATE_PROJECT]))).toHaveLength(1);
    expect(grantIssues(agentInput([READ_PROJECT, CREATE_PROJECT]))).toEqual([]);
  });
});

describe("step definition grants by kind: entity", () => {
  concurrentTest("a code step keeps its project grants", () => {
    const grants = [READ_PROJECT, CREATE_PROJECT, UPDATE_PROJECT];
    expect(
      StepDefinitionEntity.create(entityProps("code", grants)).grants,
    ).toEqual(grants);
  });

  concurrentTest("a code step may not hold grants on self", () => {
    expectGrantsInvalid(() =>
      StepDefinitionEntity.create(
        entityProps("code", [
          { resource: "workItem", action: "read", scope: "self" },
        ]),
      ),
    );
  });

  concurrentTest("an agent step may not hold update on project", () => {
    expectGrantsInvalid(() =>
      StepDefinitionEntity.create(
        entityProps("user_defined", [UPDATE_PROJECT]),
      ),
    );
  });
});
