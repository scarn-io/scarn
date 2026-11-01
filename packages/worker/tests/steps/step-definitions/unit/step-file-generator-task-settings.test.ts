import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { resolveRepoConfig } from "@scarn/sdk/repo-config";
import type { StepDefinitionSpec } from "@scarn/sdk/definitions/steps";
import {
  generateStepsFileContent,
  type StepDefContract,
} from "../../../../src/steps/step-definitions/infra/step-file-generator";

function makeStep(overrides: Partial<StepDefContract> = {}): StepDefContract {
  return {
    key: "wayfinder",
    name: "Wayfinder",
    description: null,
    prompt: "Find the way.",
    version: 1,
    status: "active",
    executionMode: "workspace",
    devcontainerConfigPath: null,
    repo: resolveRepoConfig("workspace"),
    inputSchemaJson: null,
    resultSchemaJson: null,
    opencodeMcpJson: null,
    healthChecksJson: null,
    envJson: null,
    errors: [],
    retry: [],
    maxTurns: null,
    workItemPermissions: [],
    ...overrides,
  };
}

const TASK_SETTINGS = {
  errors: ["map_missing"],
  retry: [{ on: ["map_missing", "Scarn.StepFailed"], maxAttempts: 2 }],
  maxTurns: 40,
  workItemPermissions: ["children" as const],
} satisfies Partial<StepDefContract>;

describe("generateStepsFileContent task settings", () => {
  test("emits errors, retry, maxTurns and workItemPermissions", () => {
    const content = generateStepsFileContent([makeStep(TASK_SETTINGS)]);

    expect(content).toMatchInlineSnapshot(`
      "import { z } from "zod";
      import { defineStep } from "@scarn/sdk/definitions/steps";

      export const wayfinder = defineStep({
        key: "wayfinder",
        name: "Wayfinder",
        version: 1,
        status: "active" as const,
        agentPrompt: "Find the way.",
        input: z.unknown(),
        result: z.unknown(),
        errors: ["map_missing"],
        retry: [{ on: ["map_missing","Scarn.StepFailed"], maxAttempts: 2 }],
        maxTurns: 40,
        workItemPermissions: ["children"],
      });
      "
    `);
  });

  test("omits the fields when they hold their defaults", () => {
    const content = generateStepsFileContent([makeStep()]);

    expect(content).not.toContain("errors:");
    expect(content).not.toContain("retry:");
    expect(content).not.toContain("maxTurns:");
    expect(content).not.toContain("workItemPermissions:");
  });

  test("a pulled file compiles back to the same task settings", async () => {
    const content = generateStepsFileContent([makeStep(TASK_SETTINGS)]);

    const dir = await mkdtemp(path.join(import.meta.dir, ".roundtrip-"));
    try {
      const file = path.join(dir, "steps.ts");
      await writeFile(file, content, "utf-8");
      const loaded = (await import(file)) as {
        wayfinder: StepDefinitionSpec;
      };

      expect({
        errors: loaded.wayfinder.errors,
        retryJson: loaded.wayfinder.retryJson,
        maxTurns: loaded.wayfinder.maxTurns,
        workItemPermissions: loaded.wayfinder.workItemPermissions,
      }).toEqual({
        errors: TASK_SETTINGS.errors,
        retryJson: TASK_SETTINGS.retry,
        maxTurns: TASK_SETTINGS.maxTurns,
        workItemPermissions: TASK_SETTINGS.workItemPermissions,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
