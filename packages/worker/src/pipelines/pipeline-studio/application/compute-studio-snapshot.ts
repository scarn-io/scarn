// The offline half of `scarn pipelines studio`: turn a snapshot of
// `.scarn/pipeline-builder` into the payload the SSE stream sends. Pipeline
// graphs come from the JSON pipeline documents in the directory (the same
// files `scarn pipelines publish` sends), validated with
// `@scarn/shared-core/pipelines` against the step definitions collected
// from the directory's TypeScript files. No network call, no token. In a compiled
// binary, step collection is routed through a subprocess rather than done
// in-process — see `collectDefinitions()` below.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createLazyLogger } from "@scarn/observability/logging/host";
import type { StepCatalog } from "@scarn/sdk/contracts/pipeline-document";
import {
  formatValidationError,
  validatePipeline,
  type ValidationError,
} from "@scarn/shared-core/pipelines";
import {
  nodeIdFromPath,
  translatePipelineToSnapshot,
} from "@scarn/pipeline-studio-ui";
import type {
  BrokenPipeline,
  PipelineGraphSnapshot,
  StudioIssue,
  StudioSnapshot,
} from "@scarn/pipeline-studio-ui";
import { collectDefinitionsFromDirectoryTolerant } from "@scarn/sdk/push";
import type { TolerantCollectedDefinitions } from "@scarn/sdk/push";
import {
  toStepSpec,
  type StepDefinitionSpec,
} from "@scarn/sdk/definitions/steps";
import { validateDefinitionSpecs } from "@scarn/sdk/definitions/validation";
import { collectDefinitionsViaSubprocess } from "../infra/collect-definitions-via-subprocess";

const logger = createLazyLogger({
  name: "@scarn/worker",
  scope: "pipeline-studio",
});

/** JSON files in the builder directory that are tooling config, not pipelines. */
const NON_PIPELINE_JSON = new Set([
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "jsconfig.json",
  "deno.json",
]);

/**
 * A `bun build --compile`d binary can't resolve `@scarn/sdk`'s
 * `exports`-map subpaths for the user's own real, external pipeline-builder
 * files, so collection has to happen differently depending on how this code
 * itself is currently running:
 *
 * - Compiled (`Bun.isStandaloneExecutable`): spawn a real bun/tsx/deno
 *   subprocess found on the user's PATH to do the import — see
 *   `collect-definitions-via-subprocess.ts`.
 * - Source checkout / `bun run` (dev, tests): import directly, in-process.
 */
function collectDefinitions(
  builderDir: string,
): Promise<TolerantCollectedDefinitions> {
  return Bun.isStandaloneExecutable
    ? collectDefinitionsViaSubprocess(builderDir)
    : collectDefinitionsFromDirectoryTolerant(builderDir);
}

/**
 * The highest local version of each step key, with the error names it
 * declares. Takes handles or plain specs.
 */
export function buildLocalStepCatalog(
  steps: readonly StepDefinitionSpec[],
): StepCatalog {
  const latest = new Map<string, StepDefinitionSpec>();
  for (const step of steps.map(toStepSpec)) {
    const current = latest.get(step.key);
    if (!current || step.version > current.version) latest.set(step.key, step);
  }
  return Object.fromEntries(
    [...latest.values()].map((step) => [
      step.key,
      {
        inputSchema: step.inputSchemaJson ?? true,
        resultSchema: step.resultSchemaJson ?? true,
        errors: [...(step.errors ?? [])],
      },
    ]),
  );
}

function toStudioIssue(
  error: ValidationError,
  pipelineKey: string,
): StudioIssue {
  return {
    code: error.code,
    severity: "error",
    message: error.message,
    hint: error.hint,
    path: error.path,
    pipelineKey,
    nodeId: nodeIdFromPath(error.path),
  };
}

type DocumentResult =
  | { ok: true; snapshot: PipelineGraphSnapshot; issues: StudioIssue[] }
  | { ok: false; broken: BrokenPipeline };

function readDocumentFile(
  builderDir: string,
  file: string,
  catalog: StepCatalog,
): DocumentResult | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(builderDir, file), "utf8"));
  } catch (error) {
    return {
      ok: false,
      broken: {
        key: file,
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
  if (typeof parsed !== "object" || parsed === null || !("nodes" in parsed)) {
    return null;
  }
  const result = validatePipeline(parsed, catalog);
  if (!result.document) {
    return {
      ok: false,
      broken: {
        key: file,
        message: result.errors.map(formatValidationError).join("\n"),
      },
    };
  }
  const issues = result.errors.map((error) =>
    toStudioIssue(error, result.document?.key ?? file),
  );
  return {
    ok: true,
    snapshot: translatePipelineToSnapshot(result.document, issues, catalog),
    issues,
  };
}

function listDocumentFiles(builderDir: string): string[] {
  return readdirSync(builderDir)
    .filter((file) => file.endsWith(".json") && !NON_PIPELINE_JSON.has(file))
    .sort();
}

/** A snapshot plus the step definitions collected from the same directory. */
export type StudioState = {
  snapshot: StudioSnapshot;
  /** Every step collected from the directory's TypeScript files. */
  steps: readonly StepDefinitionSpec[];
};

/**
 * Reads, validates, and translates every pipeline document in `builderDir`
 * into the shape `run-pipeline-studio-server.ts` broadcasts over SSE, and
 * keeps the collected steps alongside it. Never throws.
 *
 * A JSON file that can't be parsed, or doesn't match the document schema,
 * becomes a `brokenPipelines` entry; every other pipeline still renders. A
 * TypeScript file that fails to import is reported the same way, and its
 * steps are missing from the catalog. Only failures that can't be pinned on
 * one file (the directory itself vanishing, ...) turn into a whole-snapshot
 * `{status: "error"}` with no steps.
 */
export async function computeStudioState(
  builderDir: string,
): Promise<StudioState> {
  const collectedAt = new Date().toISOString();

  try {
    const collected = await collectDefinitions(builderDir);
    const catalog = buildLocalStepCatalog(collected.steps);
    const stepIssues: StudioIssue[] = validateDefinitionSpecs(
      collected.steps,
    ).map((issue) => ({
      code: issue.check,
      severity: issue.severity,
      message: issue.message,
    }));

    const pipelines: PipelineGraphSnapshot[] = [];
    const brokenPipelines: BrokenPipeline[] = collected.brokenPipelines.map(
      (broken) => ({ key: `${broken.key}.ts`, message: broken.message }),
    );
    const documentIssues: StudioIssue[] = [];
    for (const file of listDocumentFiles(builderDir)) {
      const result = readDocumentFile(builderDir, file, catalog);
      if (result === null) continue;
      if (result.ok) {
        pipelines.push(result.snapshot);
        documentIssues.push(...result.issues);
      } else {
        brokenPipelines.push(result.broken);
      }
    }

    return {
      snapshot: {
        status: "ok",
        pipelines,
        brokenPipelines,
        validationIssues: [...documentIssues, ...stepIssues],
        collectedAt,
      },
      steps: collected.steps.map(toStepSpec),
    };
  } catch (error) {
    logger.error({ err: error }, "Failed to compute pipeline studio snapshot");
    return {
      snapshot: {
        status: "error",
        message: error instanceof Error ? error.message : String(error),
        collectedAt,
      },
      steps: [],
    };
  }
}

/** `computeStudioState` without the steps. Never throws. */
export async function computeStudioSnapshot(
  builderDir: string,
): Promise<StudioSnapshot> {
  return (await computeStudioState(builderDir)).snapshot;
}
