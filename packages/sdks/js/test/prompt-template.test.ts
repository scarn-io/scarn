import { describe, expect, test } from "bun:test";
import {
  createPromptTemplateContext,
  renderPromptTemplate,
} from "../src/definitions/steps/prompt-template";

describe("prompt-template", () => {
  test("creates scoped prompt tokens for function prompts", () => {
    const { input, env, scarn } = createPromptTemplateContext<{
      title: string;
    }>();

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-conversion
    expect(input.title.toString()).toBe("{{input.title}}");
    expect(String(env.BASE_URL)).toBe("{{env.BASE_URL}}");
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-conversion
    expect(scarn.artifactsDir.toString()).toBe("{{scarn.artifactsDir}}");
  });

  test("renders scoped and legacy-compatible prompt variables", () => {
    const rendered = renderPromptTemplate(
      [
        "Open {{env.BASE_URL}} for {{input.title}}.",
        "Legacy title: {{title}}.",
        "Artifacts: {{scarn.artifactsDir}} and {{stepArtifactsDir}}.",
        "Missing: {{env.MISSING}}.",
      ].join("\n"),
      {
        title: "Checkout bug",
        input: { title: "Checkout bug" },
        env: { BASE_URL: "https://app.example.com" },
        scarn: { artifactsDir: "/workspace/.scarn/step-artifacts/" },
        stepArtifactsDir: "/workspace/.scarn/step-artifacts/",
      },
    );

    expect(rendered).toBe(
      [
        "Open https://app.example.com for Checkout bug.",
        "Legacy title: Checkout bug.",
        "Artifacts: /workspace/.scarn/step-artifacts/ and /workspace/.scarn/step-artifacts/.",
        "Missing: .",
      ].join("\n"),
    );
  });
});
