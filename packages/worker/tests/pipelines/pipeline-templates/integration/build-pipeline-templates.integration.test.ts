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

type BuiltNode = { kind: string; step?: string; maxTurns?: number };

describe("pipeline templates build", () => {
  for (const template of listPipelineTemplates()) {
    test(`"${template.key}" renders with defaults and builds with no errors`, async () => {
      const dir = makeBuilderDir();
      try {
        const file = join(dir, `${template.pipelineKey}.ts`);
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
        expect(result.files[0]?.key).toBe(template.pipelineKey);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 30_000);
  }

  test("wayfinder's graph is plan → done, with maxTurns on the plan node", async () => {
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
          pipelineKey: "wayfinder-2",
        }),
      );

      const result = await buildPipelineDocuments({
        builderDir: dir,
        files: [file],
      });
      expect(result.ok).toBe(true);

      const document = JSON.parse(
        readFileSync(join(dir, "wayfinder-2.json"), "utf8"),
      ) as { nodes: Record<string, BuiltNode> };
      const stepNodes = Object.values(document.nodes).filter(
        (node) => node.kind === "step",
      );
      expect(stepNodes).toHaveLength(1);
      expect(stepNodes[0]?.step).toBe("plan");
      expect(stepNodes[0]?.maxTurns).toBe(10);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
