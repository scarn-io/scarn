import { describe, expect } from "bun:test";
import { createUuidV7 } from "@/common/contracts/uuid-v7";
import { CoreValidationError } from "@/lib/errors";
import { assertStepKindFitsRuntime } from "@/pipeline-definitions/step-definition/domain/assert-step-kind-fits-runtime";
import {
  StepDefinitionEntity,
  type CreateStepDefinitionEntityProps,
} from "@/pipeline-definitions/step-definition/domain/step-definition-entity";
import { concurrentTest } from "tests/utils";

const expectCoreValidationCode = (fn: () => void, code: string) => {
  expect(fn).toThrow(CoreValidationError);
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(CoreValidationError);
    expect((error as CoreValidationError).code).toBe(code);
  }
};

function baseProps(): CreateStepDefinitionEntityProps {
  return {
    projectId: createUuidV7(),
    key: "demo-step",
    name: "Demo Step",
    prompt: "Do the thing",
    version: 1,
    kind: "user_defined",
    inputSchemaJson: { type: "object" },
    resultSchemaJson: { type: "object" },
    taskExecutionConfigId: createUuidV7(),
    status: "active",
  };
}

describe("step definition entity: kind 'code'", () => {
  concurrentTest("creates successfully with a valid entrypointJson", () => {
    const entity = StepDefinitionEntity.create({
      ...baseProps(),
      kind: "code",
      prompt: null,
      entrypointJson: {
        sourceFile: ".scarn/pipeline-builder/review-file-step.ts",
      },
    });

    expect(entity.kind).toBe("code");
    expect(entity.prompt).toBeNull();
    expect(entity.entrypointJson).toEqual({
      sourceFile: ".scarn/pipeline-builder/review-file-step.ts",
    });
  });

  concurrentTest("throws when entrypointJson is missing", () => {
    expectCoreValidationCode(
      () =>
        StepDefinitionEntity.create({
          ...baseProps(),
          kind: "code",
          prompt: null,
        }),
      "STEP_DEFINITION_ENTRYPOINT_REQUIRED",
    );
  });

  concurrentTest(
    "throws when entrypointJson.sourceFile is empty/whitespace",
    () => {
      expectCoreValidationCode(
        () =>
          StepDefinitionEntity.create({
            ...baseProps(),
            kind: "code",
            prompt: null,
            entrypointJson: { sourceFile: "  " },
          }),
        "STEP_DEFINITION_ENTRYPOINT_REQUIRED",
      );
    },
  );

  concurrentTest("requires a result schema", () => {
    expectCoreValidationCode(
      () =>
        StepDefinitionEntity.create({
          ...baseProps(),
          kind: "code",
          prompt: null,
          entrypointJson: { sourceFile: "step.ts" },
          resultSchemaJson: null,
        }),
      "STEP_DEFINITION_RESULT_SCHEMA_REQUIRED",
    );
  });

  concurrentTest("throws when a 'code' step is given a prompt", () => {
    expectCoreValidationCode(
      () =>
        StepDefinitionEntity.create({
          ...baseProps(),
          kind: "code",
          prompt: "Do the thing",
          entrypointJson: { sourceFile: "step.ts" },
        }),
      "STEP_DEFINITION_PROMPT_NOT_ALLOWED",
    );
  });
});

describe("assertStepKindFitsRuntime", () => {
  concurrentTest("rejects a 'code' step on a no-workspace runtime", () => {
    expectCoreValidationCode(() => {
      assertStepKindFitsRuntime("code", { kind: "host" });
    }, "STEP_DEFINITION_CODE_RUNTIME_KIND_NOT_ALLOWED");
  });

  concurrentTest("accepts a 'code' step on a workspace runtime", () => {
    expect(() => {
      assertStepKindFitsRuntime("code", { kind: "managed", id: "bun1" });
    }).not.toThrow();
  });

  concurrentTest.each(["user_defined", "built_in"] as const)(
    "allows a '%s' step on a no-workspace runtime",
    (kind) => {
      expect(() => {
        assertStepKindFitsRuntime(kind, { kind: "host" });
      }).not.toThrow();
    },
  );

  concurrentTest.each(["user_defined", "built_in"] as const)(
    "allows a managed runtime on a '%s' step",
    (kind) => {
      expect(() => {
        assertStepKindFitsRuntime(kind, { kind: "managed", id: "bun1" });
      }).not.toThrow();
    },
  );
});

describe("step definition entity: kind 'user_defined'", () => {
  concurrentTest("requires a prompt", () => {
    expectCoreValidationCode(
      () =>
        StepDefinitionEntity.create({
          ...baseProps(),
          kind: "user_defined",
          prompt: null,
        }),
      "STEP_DEFINITION_PROMPT_REQUIRED",
    );
  });

  concurrentTest("may have no result schema: a conversation step", () => {
    const entity = StepDefinitionEntity.create({
      ...baseProps(),
      kind: "user_defined",
      resultSchemaJson: null,
    });
    expect(entity.resultSchemaJson).toBeNull();
  });

  concurrentTest("throws when a whitespace-only prompt is given", () => {
    expectCoreValidationCode(
      () =>
        StepDefinitionEntity.create({
          ...baseProps(),
          kind: "user_defined",
          prompt: "   ",
        }),
      "STEP_DEFINITION_PROMPT_REQUIRED",
    );
  });

  concurrentTest(
    "throws when a non-'code' step is given entrypointJson",
    () => {
      expectCoreValidationCode(
        () =>
          StepDefinitionEntity.create({
            ...baseProps(),
            kind: "user_defined",
            entrypointJson: { sourceFile: "step.ts" },
          }),
        "STEP_DEFINITION_ENTRYPOINT_NOT_ALLOWED",
      );
    },
  );
});

describe("step definition entity: kind 'built_in'", () => {
  concurrentTest(
    "is not kind-specifically validated (no prompt/entrypointJson required)",
    () => {
      const entity = StepDefinitionEntity.create({
        ...baseProps(),
        kind: "built_in",
        prompt: null,
      });
      expect(entity.kind).toBe("built_in");
      expect(entity.entrypointJson).toBeNull();
    },
  );

  concurrentTest(
    "throws when a 'built_in' step is given entrypointJson",
    () => {
      expectCoreValidationCode(
        () =>
          StepDefinitionEntity.create({
            ...baseProps(),
            kind: "built_in",
            entrypointJson: { sourceFile: "step.ts" },
          }),
        "STEP_DEFINITION_ENTRYPOINT_NOT_ALLOWED",
      );
    },
  );
});
