import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { resolveRepoConfig } from "@scarn/sdk/repo-config";
import {
  defineStep,
  Features,
  type StepDefinitionSpec,
} from "@scarn/sdk/definitions/steps";
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
    grants: [],
    ...overrides,
  };
}

const TASK_SETTINGS = {
  errors: ["map_missing"],
  retry: [{ on: ["map_missing", "Scarn.StepFailed"], maxAttempts: 2 }],
  maxTurns: 40,
} satisfies Partial<StepDefContract>;

const granted = defineStep({
  key: "wayfinder",
  name: "Wayfinder",
  agentPrompt: "Find the way.",
  features: [
    Features.workItems.read({ scope: "self" }),
    Features.workItems.label({ scope: "self", labels: ["triaged"] }),
    Features.workItems.create({
      scope: "children",
      labels: ["wayfinder:research", "wayfinder:prototype"],
    }),
  ],
}) as unknown as StepDefinitionSpec;

const GRANTED = {
  prompt: granted.prompt,
  grants: granted.grants,
} satisfies Partial<StepDefContract>;

describe("generateStepsFileContent task settings", () => {
  test("emits errors, retry and maxTurns", () => {
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
      });
      "
    `);
  });

  test("omits the fields when they hold their defaults", () => {
    const content = generateStepsFileContent([makeStep()]);

    expect(content).not.toContain("errors:");
    expect(content).not.toContain("retry:");
    expect(content).not.toContain("maxTurns:");
    expect(content).not.toContain("features:");
    expect(content).not.toContain("Features");
  });

  test("emits a Features.workItems call per grant", () => {
    const content = generateStepsFileContent([makeStep(GRANTED)]);

    expect(content).toMatchInlineSnapshot(`
      "import { z } from "zod";
      import { defineStep, Features } from "@scarn/sdk/definitions/steps";

      export const wayfinder = defineStep({
        key: "wayfinder",
        name: "Wayfinder",
        version: 1,
        status: "active" as const,
        agentPrompt: "Find the way.",
        input: z.unknown(),
        result: z.unknown(),
        features: [
          Features.workItems.read({ scope: "self" }),
          Features.workItems.label({ scope: "self", labels: ["triaged"] }),
          Features.workItems.create({ scope: "children", labels: ["wayfinder:research","wayfinder:prototype"] }),
        ],
      });
      "
    `);
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
      }).toEqual({
        errors: TASK_SETTINGS.errors,
        retryJson: TASK_SETTINGS.retry,
        maxTurns: TASK_SETTINGS.maxTurns,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a pulled file compiles back to the same grants and prompt", async () => {
    const content = generateStepsFileContent([makeStep(GRANTED)]);

    const dir = await mkdtemp(path.join(import.meta.dir, ".roundtrip-"));
    try {
      const file = path.join(dir, "steps.ts");
      await writeFile(file, content, "utf-8");
      const loaded = (await import(file)) as {
        wayfinder: StepDefinitionSpec;
      };

      expect({
        prompt: loaded.wayfinder.prompt,
        grants: loaded.wayfinder.grants,
      }).toEqual(GRANTED);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
