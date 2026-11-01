import { describe, expect, test } from "bun:test";
import {
  findPipelineTemplate,
  listPipelineTemplates,
} from "../../../../src/pipelines/pipeline-templates/application/list-pipeline-templates";
import { renderPipelineTemplate } from "../../../../src/pipelines/pipeline-templates/application/render-pipeline-template";
import type { PipelineTemplate } from "../../../../src/pipelines/pipeline-templates/domain/pipeline-template";

function template(key: string): PipelineTemplate {
  const found = findPipelineTemplate(key);
  if (found === undefined) throw new Error(`No template "${key}"`);
  return found;
}

const FAKE: PipelineTemplate = {
  key: "fake",
  name: "Fake",
  summary: "A fake.",
  descriptionMarkdown: "A fake.",
  tags: [],
  pipelineKey: "fake",
  stepKeys: [],
  handoffSteps: [],
  parameters: [
    { key: "greeting", label: "Greeting", type: "text", required: false },
  ],
  source: [
    "// @scarn-template-params",
    'const GREETING = "hi";',
    "",
    "export default definePipeline({",
    '  key: "fake", // @scarn-template-pipeline-key',
    "});",
  ].join("\n"),
};

describe("listPipelineTemplates", () => {
  test("lists wayfinder, then web repro", () => {
    expect(listPipelineTemplates().map((t) => t.key)).toEqual([
      "wayfinder",
      "web-repro-playwright",
    ]);
  });

  test("every template's step keys are exported steps in its source", () => {
    for (const t of listPipelineTemplates()) {
      for (const key of t.stepKeys) {
        expect(t.source).toContain(`key: "${key}",`);
      }
      for (const handoff of t.handoffSteps) {
        expect(t.stepKeys).toContain(handoff.key);
        expect(t.stepKeys).toContain(handoff.startedBy);
      }
    }
  });
});

describe("renderPipelineTemplate", () => {
  test("prepends the provenance header and strips every marker", () => {
    for (const t of listPipelineTemplates()) {
      const rendered = renderPipelineTemplate(t, { cliVersion: "1.2.3" });
      expect(rendered.split("\n")[0]).toBe(
        `// Created from the "${t.key}" pipeline template (scarn 1.2.3).`,
      );
      expect(rendered).not.toContain("@scarn-template-");
      expect(rendered).toContain(`key: "${t.pipelineKey}",`);
    }
  });

  test("writes parameter values as JSON literals, so quotes and backticks are safe", () => {
    const value = 'Use "quotes", `backticks` and ${injection}.\nTwo lines.';
    const rendered = renderPipelineTemplate(template("wayfinder"), {
      cliVersion: "0.0.0",
      parameterValues: { planning_guidance: value },
    });
    expect(rendered).toContain(
      `const PLANNING_GUIDANCE = ${JSON.stringify(value)};`,
    );
  });

  test("keeps the default for a parameter left out", () => {
    const rendered = renderPipelineTemplate(FAKE, { cliVersion: "0.0.0" });
    expect(rendered).toContain('const GREETING = "hi";');
  });

  test("renames the pipeline key on the marker line only", () => {
    const rendered = renderPipelineTemplate(template("wayfinder"), {
      cliVersion: "0.0.0",
      pipelineKey: "wayfinder-2",
    });
    expect(rendered).toContain('  key: "wayfinder-2",\n');
    expect(rendered).not.toContain('key: "wayfinder",');
    expect(rendered).toContain('key: "plan",');
  });

  test("rejects an unknown parameter", () => {
    expect(() =>
      renderPipelineTemplate(FAKE, {
        cliVersion: "0.0.0",
        parameterValues: { nope: "x" },
      }),
    ).toThrow('unknown parameter "nope"');
  });

  test("rejects an invalid pipeline key", () => {
    expect(() =>
      renderPipelineTemplate(FAKE, {
        cliVersion: "0.0.0",
        pipelineKey: 'bad"key',
      }),
    ).toThrow("may only contain");
  });

  test("rejects a params block that doesn't declare every parameter", () => {
    expect(() =>
      renderPipelineTemplate(
        { ...FAKE, source: FAKE.source.replace('const GREETING = "hi";', "") },
        { cliVersion: "0.0.0" },
      ),
    ).toThrow('missing "const GREETING"');
  });

  test("rejects a source without a pipeline-key marker", () => {
    expect(() =>
      renderPipelineTemplate(
        {
          ...FAKE,
          source: FAKE.source.replace(" // @scarn-template-pipeline-key", ""),
        },
        { cliVersion: "0.0.0" },
      ),
    ).toThrow("exactly one");
  });

  test("rejects a leftover marker", () => {
    expect(() =>
      renderPipelineTemplate(
        { ...FAKE, source: `${FAKE.source}\n// @scarn-template-other` },
        { cliVersion: "0.0.0" },
      ),
    ).toThrow("still has a template marker");
  });
});
