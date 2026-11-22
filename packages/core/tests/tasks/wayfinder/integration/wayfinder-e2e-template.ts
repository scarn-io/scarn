import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { createApp } from "@scarn/api/app";
import { pushFromDirectory } from "@scarn/sdk/push";
import {
  buildPipelineDocuments,
  findPipelineTemplate,
  renderPipelineTemplate,
  scaffoldPipelineBuilderDirectory,
  STARTER_DEFAULT_AUTOMATION_FILENAME,
  STARTER_PIPELINE_FILENAME,
  STARTER_PIPELINE_JSON_FILENAME,
} from "@scarn/worker";

const BASE_URL = "http://scarn.test";
const CORE_NODE_MODULES = resolve(import.meta.dir, "../../../../node_modules");

/**
 * A pipeline-builder directory holding what `scarn pipelines template use
 * wayfinder` gives a user: the rendered Wayfinder template, built to
 * `wayfinder.json` (its four steps and the work-item automation).
 */
export const buildWayfinderBuilderDirectory = async (): Promise<string> => {
  const template = findPipelineTemplate("wayfinder");
  if (template === undefined) {
    throw new Error("Expected the wayfinder pipeline template");
  }
  const dir = mkdtempSync(join(tmpdir(), "scarn-wayfinder-e2e-"));
  scaffoldPipelineBuilderDirectory(dir, "0.0.0");
  rmSync(join(dir, STARTER_PIPELINE_FILENAME));
  rmSync(join(dir, STARTER_PIPELINE_JSON_FILENAME));
  rmSync(join(dir, STARTER_DEFAULT_AUTOMATION_FILENAME));
  symlinkSync(CORE_NODE_MODULES, join(dir, "node_modules"), "dir");
  writeFileSync(join(dir, "bun.lock"), "");
  const file = join(dir, `${template.entry.key}.ts`);
  writeFileSync(
    file,
    renderPipelineTemplate(template, { cliVersion: "0.0.0" }),
  );
  const built = await buildPipelineDocuments({
    builderDir: dir,
    files: [file],
  });
  if (!built.ok) {
    throw new Error(
      `Expected the wayfinder template to build:\n${built.files.flatMap((report) => report.errors).join("\n")}`,
    );
  }
  return dir;
};

/** Runs `pushFromDirectory` with every request routed into `app`. */
export const pushToApp = (
  app: ReturnType<typeof createApp>,
  dir: string,
  projectId: string,
  accessToken: string,
) =>
  pushFromDirectory(dir, {
    baseUrl: BASE_URL,
    projectId,
    fetch: (input, init) => {
      const request = new Request(input, init);
      request.headers.set("Authorization", `Bearer ${accessToken}`);
      return app.handle(request);
    },
    log: () => {},
  });
