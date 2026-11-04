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
  entry: { kind: "pipeline", key: "fake" },
  stepKeys: [],
  parameters: [
    { key: "greeting", label: "Greeting", type: "text", required: false },
  ],
  source: [
    "// @scarn-template-params",
    'const GREETING = "hi";',
    "",
    "export default definePipeline({",
    '  key: "fake", // @scarn-template-entry-key',
    "});",
  ].join("\n"),
};

const FAKE_AUTOMATION: PipelineTemplate = {
  key: "fake-automation",
  name: "Fake automation",
  summary: "A fake automation.",
  descriptionMarkdown: "A fake automation.",
  tags: [],
  entry: { kind: "automation", key: "fake-automation" },
  stepKeys: ["research"],
  parameters: [],
  source: [
    "export const research = defineStep({",
    '  key: "research",',
    "});",
    "",
    "export default defineAutomation({",
    '  key: "fake-automation", // @scarn-template-entry-key',
    '  scope: "workItem",',
    '  rules: [onEvent("self.attached", () => research)],',
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
      expect(rendered).toContain(`key: "${t.entry.key}",`);
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

  test("renames wayfinder's automation key on its defineAutomation marker line only", () => {
    const rendered = renderPipelineTemplate(template("wayfinder"), {
      cliVersion: "0.0.0",
      entryKey: "wayfinder-2",
    });
    expect(rendered).toContain(
      'export default defineAutomation({\n  key: "wayfinder-2",\n',
    );
    expect(rendered).not.toContain('key: "wayfinder",');
    for (const step of ["plan", "research", "prototype", "grilling"]) {
      expect(rendered).toContain(`  key: "${step}",`);
    }
  });

  test("renders wayfinder as an automation with no pipeline or step input", () => {
    const t = template("wayfinder");
    expect(t.entry).toEqual({ kind: "automation", key: "wayfinder" });
    const rendered = renderPipelineTemplate(t, { cliVersion: "0.0.0" });
    expect(rendered).not.toContain("definePipeline");
    expect(rendered).not.toContain("input:");
    expect(rendered).not.toContain("scarn-start-task");
    expect(rendered).not.toContain("scarn-wait-for-work");
    expect(rendered).not.toContain("WORK_ITEM_INPUT");
  });

  test("renames an automation's key on its defineAutomation marker line", () => {
    const rendered = renderPipelineTemplate(FAKE_AUTOMATION, {
      cliVersion: "0.0.0",
      entryKey: "fake-automation-2",
    });
    expect(rendered).toContain(
      'export default defineAutomation({\n  key: "fake-automation-2",\n',
    );
    expect(rendered).not.toContain('key: "fake-automation",');
    expect(rendered).toContain('  key: "research",');
    expect(rendered).not.toContain("@scarn-template-");
  });

  test("keeps an automation's own key by default", () => {
    const rendered = renderPipelineTemplate(FAKE_AUTOMATION, {
      cliVersion: "0.0.0",
    });
    expect(rendered).toContain('  key: "fake-automation",\n');
  });

  test("rejects an entry-key marker outside the call its kind names", () => {
    expect(() =>
      renderPipelineTemplate(
        { ...FAKE_AUTOMATION, entry: { kind: "pipeline", key: "x" } },
        { cliVersion: "0.0.0" },
      ),
    ).toThrow("must be inside the definePipeline(…) call");
    expect(() =>
      renderPipelineTemplate(
        { ...FAKE, entry: { kind: "automation", key: "fake" } },
        { cliVersion: "0.0.0" },
      ),
    ).toThrow("must be inside the defineAutomation(…) call");
  });

  test("rejects an entry-key marker on a step inside the automation's file", () => {
    const source = FAKE_AUTOMATION.source
      .replace(" // @scarn-template-entry-key", "")
      .replace(
        '  key: "research",',
        '  key: "research", // @scarn-template-entry-key',
      );
    expect(() =>
      renderPipelineTemplate(
        { ...FAKE_AUTOMATION, source },
        { cliVersion: "0.0.0" },
      ),
    ).toThrow("must be inside the defineAutomation(…) call");
  });

  test("rejects an unknown parameter", () => {
    expect(() =>
      renderPipelineTemplate(FAKE, {
        cliVersion: "0.0.0",
        parameterValues: { nope: "x" },
      }),
    ).toThrow('unknown parameter "nope"');
  });

  test("rejects an invalid entry key", () => {
    expect(() =>
      renderPipelineTemplate(FAKE, {
        cliVersion: "0.0.0",
        entryKey: 'bad"key',
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

  test("rejects a source without an entry-key marker", () => {
    expect(() =>
      renderPipelineTemplate(
        {
          ...FAKE,
          source: FAKE.source.replace(" // @scarn-template-entry-key", ""),
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
