/**
 * Builds what a template's detail page shows before it is used: the template
 * rendered with its defaults into a throwaway builder directory, built with
 * `buildPipelineDocuments` and read back with `computeStudioState`. That is
 * the path the studio's file watcher takes after "Use" writes the file, so
 * the preview matches what the user gets.
 *
 * The throwaway directory borrows the real builder directory's dependencies
 * through a `node_modules` symlink, and copies its `package.json`,
 * `tsconfig.json` and the names of its lockfiles (empty) so the same runtime
 * is detected.
 */
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PipelineGraphSnapshot } from "@scarn/pipeline-studio-ui";
import type { StepDefinitionSpec } from "@scarn/sdk/definitions/steps";
import { createLazyLogger } from "@scarn/observability/logging/host";
import { buildPipelineDocuments } from "../../pipeline-definitions/application/build-pipeline-documents";
import { computeStudioState } from "../../pipeline-studio/application/compute-studio-snapshot";
import type { PipelineTemplate } from "../domain/pipeline-template";
import { renderPipelineTemplate } from "./render-pipeline-template";

const logger = createLazyLogger({
  name: "@scarn/worker",
  scope: "pipeline-templates",
});

const COPIED_CONFIG_FILES = ["package.json", "tsconfig.json"] as const;
const LOCKFILES = [
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "deno.lock",
  "deno.json",
] as const;

/** What a step's detail panel shows. */
export type TemplateStepPreview = {
  key: string;
  name: string;
  description: string | null;
  prompt: string | null;
  runtime: {
    executionMode: "workspace" | "no_workspace";
    devcontainerConfigPath: string | null;
    managedRuntime: string | null;
  };
  /** `null` when the step leaves repository access to the runtime's default. */
  repo: StepDefinitionSpec["repo"] | null;
  workItemPermissions: string[];
  maxTurns: number | null;
  inputSchema: Record<string, unknown> | null;
  resultSchema: Record<string, unknown> | null;
};

export type PipelineTemplatePreview = {
  /** The pipeline's graph; `null` when the template failed to build. */
  pipeline: PipelineGraphSnapshot | null;
  /** Every step the file exports, in the template's `stepKeys` order. */
  steps: TemplateStepPreview[];
  /** Build and validation errors. Empty for a healthy template. */
  errors: string[];
};

export type BuildPipelineTemplatePreviewOptions = {
  /** The real builder directory, whose dependencies the build borrows. */
  builderDir: string;
  cliVersion: string;
};

function toStepPreview(step: StepDefinitionSpec): TemplateStepPreview {
  return {
    key: step.key,
    name: step.name,
    description: step.description,
    prompt: step.prompt,
    runtime: {
      executionMode: step.executionMode ?? "workspace",
      devcontainerConfigPath: step.devcontainerConfigPath ?? null,
      managedRuntime: step.managedRuntime ?? null,
    },
    repo: step.repo ?? null,
    workItemPermissions: [...(step.workItemPermissions ?? [])],
    maxTurns: step.maxTurns ?? null,
    inputSchema: step.inputSchemaJson,
    resultSchema: step.resultSchemaJson,
  };
}

function makePreviewDir(builderDir: string): string {
  const dir = mkdtempSync(join(tmpdir(), "scarn-template-preview-"));
  const nodeModules = join(builderDir, "node_modules");
  if (existsSync(nodeModules)) {
    symlinkSync(nodeModules, join(dir, "node_modules"), "dir");
  }
  for (const file of COPIED_CONFIG_FILES) {
    if (existsSync(join(builderDir, file))) {
      copyFileSync(join(builderDir, file), join(dir, file));
    }
  }
  for (const file of LOCKFILES) {
    if (existsSync(join(builderDir, file))) writeFileSync(join(dir, file), "");
  }
  return dir;
}

export async function buildPipelineTemplatePreview(
  template: PipelineTemplate,
  options: BuildPipelineTemplatePreviewOptions,
): Promise<PipelineTemplatePreview> {
  const dir = makePreviewDir(options.builderDir);
  try {
    const file = join(dir, `${template.pipelineKey}.ts`);
    writeFileSync(
      file,
      renderPipelineTemplate(template, { cliVersion: options.cliVersion }),
    );
    const build = await buildPipelineDocuments({
      builderDir: dir,
      files: [file],
    });
    const errors = build.files.flatMap((report) => report.errors);

    const { snapshot, steps } = await computeStudioState(dir);
    if (snapshot.status === "error") errors.push(snapshot.message);
    const pipeline =
      snapshot.status === "ok"
        ? (snapshot.pipelines.find((p) => p.key === template.pipelineKey) ??
          null)
        : null;
    if (snapshot.status === "ok") {
      errors.push(
        ...snapshot.brokenPipelines.map(
          (broken) => `${broken.key}: ${broken.message}`,
        ),
      );
    }

    const byKey = new Map(steps.map((step) => [step.key, step]));
    return {
      pipeline,
      steps: template.stepKeys.flatMap((key) => {
        const step = byKey.get(key);
        return step ? [toStepPreview(step)] : [];
      }),
      errors,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export type PipelineTemplatePreviewCache = {
  get(template: PipelineTemplate): Promise<PipelineTemplatePreview>;
};

/**
 * Builds each template's preview once per `template key + CLI version` and
 * keeps it for the life of the process. A preview that failed to build isn't
 * kept, so it is retried on the next request (after `bun install`, say).
 */
export function createPipelineTemplatePreviewCache(
  options: BuildPipelineTemplatePreviewOptions,
): PipelineTemplatePreviewCache {
  const cache = new Map<string, Promise<PipelineTemplatePreview>>();
  return {
    get(template) {
      const cacheKey = `${template.key}@${options.cliVersion}`;
      const cached = cache.get(cacheKey);
      if (cached) return cached;
      const pending = (async () => {
        let kept = false;
        try {
          const preview = await buildPipelineTemplatePreview(template, options);
          kept = preview.errors.length === 0 && preview.pipeline !== null;
          if (!kept) {
            logger.warn(
              { template: template.key, errors: preview.errors },
              "Pipeline template preview failed to build",
            );
          }
          return preview;
        } finally {
          if (!kept) cache.delete(cacheKey);
        }
      })();
      cache.set(cacheKey, pending);
      return pending;
    },
  };
}
