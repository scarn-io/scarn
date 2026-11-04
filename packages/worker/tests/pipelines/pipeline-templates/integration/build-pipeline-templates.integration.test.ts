/**
 * Every template, rendered with its defaults into a scaffolded builder
 * directory, must build with no errors. This catches template drift whenever
 * the SDK changes.
 */
import { describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildPipelineDocuments } from "../../../../src/pipelines/pipeline-definitions/application/build-pipeline-documents";
import { scaffoldPipelineBuilderDirectory } from "../../../../src/pipelines/pipeline-definitions/infra/pipeline-builder-scaffolder";
import { listPipelineTemplates } from "../../../../src/pipelines/pipeline-templates/application/list-pipeline-templates";
import { renderPipelineTemplate } from "../../../../src/pipelines/pipeline-templates/application/render-pipeline-template";

const WORKER_NODE_MODULES = resolve(
  import.meta.dir,
  "../../../../node_modules",
);

function makeBuilderDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "scarn-pipeline-template-test-"));
  scaffoldPipelineBuilderDirectory(dir, "0.0.0");
  symlinkSync(WORKER_NODE_MODULES, join(dir, "node_modules"), "dir");
  writeFileSync(join(dir, "bun.lock"), "");
  return dir;
}

type BuiltRoute = {
  kind: string;
  to?: string;
  on?: string;
  when?: { value?: string };
};
type BuiltAutomation = {
  kind: string;
  key: string;
  scope: string;
  rules: {
    event: string;
    next: { routes: BuiltRoute[]; otherwise?: BuiltRoute };
  }[];
};

describe("pipeline templates build", () => {
  for (const template of listPipelineTemplates()) {
    test(`"${template.key}" renders with defaults and builds with no errors`, async () => {
      const dir = makeBuilderDir();
      try {
        const file = join(dir, `${template.entry.key}.ts`);
        writeFileSync(
          file,
          renderPipelineTemplate(template, { cliVersion: "0.0.0" }),
        );

        const result = await buildPipelineDocuments({
          builderDir: dir,
          files: [file],
        });

        expect(result.files.flatMap((report) => report.errors)).toEqual([]);
        expect(result.ok).toBe(true);
        expect(result.files[0]?.key).toBe(template.entry.key);
        expect(result.files[0]?.kind).toBe(template.entry.kind);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 30_000);
  }

  test("wayfinder builds, under a new key, as a work-item automation routing children by label", async () => {
    const dir = makeBuilderDir();
    try {
      const template = listPipelineTemplates().find(
        (t) => t.key === "wayfinder",
      );
      if (template === undefined) throw new Error("No wayfinder template");
      const file = join(dir, "wayfinder-2.ts");
      writeFileSync(
        file,
        renderPipelineTemplate(template, {
          cliVersion: "0.0.0",
          entryKey: "wayfinder-2",
        }),
      );

      const result = await buildPipelineDocuments({
        builderDir: dir,
        files: [file],
      });
      expect(result.ok).toBe(true);

      const document = JSON.parse(
        readFileSync(join(dir, "wayfinder-2.json"), "utf8"),
      ) as BuiltAutomation;
      expect(document).toMatchObject({
        kind: "automation",
        key: "wayfinder-2",
        scope: "workItem",
      });
      expect(
        document.rules.map((rule) => ({
          event: rule.event,
          routes: rule.next.routes.map((route) => [route.to, route.on]),
          otherwise: rule.next.otherwise,
        })),
      ).toEqual([
        {
          event: "self.attached",
          routes: [["plan", "workItem"]],
          otherwise: undefined,
        },
        {
          event: "child.ready",
          routes: [
            ["research", "child"],
            ["prototype", "child"],
            ["grilling", "child"],
          ],
          otherwise: undefined,
        },
        {
          event: "child.closed",
          routes: [["plan", "workItem"]],
          otherwise: undefined,
        },
      ]);
      expect(
        document.rules[1]?.next.routes.map((route) => route.when?.value),
      ).toEqual([
        "wayfinder:research",
        "wayfinder:prototype",
        "wayfinder:grilling",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
