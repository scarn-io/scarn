import { describe, expect, test } from "bun:test";
import { codeStep, defineStep, z } from "@scarn/sdk/definitions/steps";
import { buildLocalStepCatalog } from "../../../../src/pipelines/pipeline-studio/application/compute-studio-snapshot";

describe("buildLocalStepCatalog", () => {
  test("builds contracts from step handles, with their declared errors", () => {
    const plan = defineStep({
      key: "plan",
      name: "Plan",
      agentPrompt: "Plan it.",
      result: z.object({ files: z.array(z.string()) }),
      errors: ["NoPlan"],
    });
    const fix = codeStep({ key: "fix", name: "Fix", fn: () => ({}) });

    const catalog = buildLocalStepCatalog([plan, fix]);

    expect(catalog["plan"]?.errors).toEqual(["NoPlan"]);
    expect(catalog["plan"]?.inputSchema).toBe(true);
    expect(catalog["plan"]?.resultSchema).toMatchObject({ type: "object" });
    expect(catalog["fix"]).toEqual({
      inputSchema: true,
      resultSchema: true,
      errors: [],
    });
  });

  test("keeps the highest version of each key", () => {
    const v1 = defineStep({ key: "s", name: "S", agentPrompt: "p" });
    const v2 = defineStep({
      key: "s",
      name: "S",
      agentPrompt: "p",
      version: 2,
      errors: ["Late"],
    });

    expect(buildLocalStepCatalog([v2, v1])["s"]?.errors).toEqual(["Late"]);
  });
});
