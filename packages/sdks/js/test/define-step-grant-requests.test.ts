import { describe, expect, test } from "bun:test";
import {
  codeStep,
  defineStep,
  Features,
  toStepSpec,
  type AnyStepFeature,
} from "../src/definitions/steps";
import { notion } from "./mcp-tool-step-fixtures";

describe("Features.grantRequests()", () => {
  test("adds no result fields, no prompt section and no grant", () => {
    const feature = Features.grantRequests();
    expect(feature._grantRequests).toBe(true);
    expect(feature._resultExtension).toBeUndefined();
    expect(feature._promptAddition).toBe("");
    expect(feature._grant).toBeUndefined();
  });

  test("defineStep sets grantRequests and leaves the prompt as written", () => {
    const step = toStepSpec(
      defineStep({
        key: "agent",
        name: "Agent",
        agentPrompt: "Do it.",
        features: [Features.grantRequests()],
      }),
    );
    expect(step.grantRequests).toBe(true);
    expect(step.prompt).toBe("Do it.");
    expect(step.grants).toBeUndefined();
  });

  test("defineStep omits grantRequests without the feature", () => {
    const step = toStepSpec(
      defineStep({ key: "agent", name: "Agent", agentPrompt: "Do it." }),
    );
    expect(step).not.toHaveProperty("grantRequests");
  });

  test("codeStep refuses it", () => {
    expect(() =>
      codeStep({
        key: "code",
        name: "Code",
        // @ts-expect-error a code step has no agent to ask for grants
        features: [Features.grantRequests()],
        fn: () => ({}),
      }),
    ).toThrow('Step "code": Features.grantRequests() is for agent steps only');
  });

  test("MCP tool steps refuse it", () => {
    const features: AnyStepFeature[] = [Features.grantRequests()];
    expect(() =>
      notion.tools.search.step({
        key: "search",
        ...({ features } as object),
      }),
    ).toThrow(
      'Step "search": Features.grantRequests() is for agent steps only',
    );
  });
});
