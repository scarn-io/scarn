/**
 * `scarn pipelines build`: compile each `definePipeline` default export in
 * the pipeline-builder directory to `<key>.json` next to its source, then
 * validate the documents against the local steps' contracts plus, for
 * `stepRef` keys, the server's catalog. With `check`, nothing is written and
 * missing or stale JSON is reported instead.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { StepCatalog } from "@scarn/sdk/contracts/pipeline-document";
import { formatIssue } from "@scarn/sdk/pipelines";
import { validatePipeline } from "@scarn/shared-core/pipelines";
import {
  formatBuildFailure,
  formatLocatedValidationError,
  mergeCatalogs,
  missingStepKeys,
  type BuiltPipeline,
} from "../domain/pipeline-build";
import { BUILD_SCRIPT_FILENAME } from "../infra/build-script";
import { runBuildScript } from "../infra/run-build-script";
import { serializePipelineDocument } from "./pull-pipeline-definitions";

/** The server's step catalog, or why it isn't available. */
export type ServerCatalogResult =
  { ok: true; catalog: StepCatalog } | { ok: false; reason: string };

export type BuildPipelineDocumentsOptions = {
  builderDir: string;
  /** Source files to build; every `.ts` file in `builderDir` when omitted. */
  files?: readonly string[];
  /** Write nothing; report missing or out-of-date JSON. */
  check?: boolean;
  /** Called at most once, only when a document uses steps not defined locally. */
  fetchServerCatalog?: (
    keys: readonly string[],
  ) => Promise<ServerCatalogResult>;
};

export type BuiltFileStatus =
  "written" | "unchanged" | "missing" | "stale" | "failed";

export type BuiltFileReport = {
  /** The source file, absolute. */
  source: string;
  key?: string;
  /** The `<key>.json` path, absolute. */
  jsonPath?: string;
  status: BuiltFileStatus;
  errors: string[];
  warnings: string[];
};

export type BuildPipelineDocumentsResult = {
  files: BuiltFileReport[];
  /** True when nothing failed, and with `check`, nothing was missing or stale. */
  ok: boolean;
};

/** Generated or config files in the builder directory that are never pipelines. */
const NON_PIPELINE_SOURCES = new Set([
  "push.ts",
  BUILD_SCRIPT_FILENAME,
  "default-pipeline-assignment.ts",
  "work-item-fields.ts",
]);

/** The `.ts` files `build` imports when no file is given. */
export function listPipelineSourceFiles(builderDir: string): string[] {
  return readdirSync(builderDir)
    .filter(
      (file) =>
        file.endsWith(".ts") &&
        !file.endsWith(".d.ts") &&
        !NON_PIPELINE_SOURCES.has(file),
    )
    .sort()
    .map((file) => join(builderDir, file));
}

function readIfExists(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

function emit(
  pipeline: BuiltPipeline,
  source: string,
  check: boolean,
): BuiltFileReport {
  const jsonPath = join(dirname(source), `${pipeline.key}.json`);
  const text = serializePipelineDocument(pipeline.document);
  const existing = readIfExists(jsonPath);
  let status: BuiltFileStatus = "unchanged";
  if (existing !== text) {
    if (check) {
      status = existing === undefined ? "missing" : "stale";
    } else {
      writeFileSync(jsonPath, text, "utf8");
      status = "written";
    }
  }
  return {
    source,
    key: pipeline.key,
    jsonPath,
    status,
    errors: [],
    warnings: pipeline.warnings.map(formatIssue),
  };
}

async function serverCatalogFor(
  pipelines: readonly BuiltPipeline[],
  fetch: BuildPipelineDocumentsOptions["fetchServerCatalog"],
): Promise<ServerCatalogResult> {
  const missing = [...new Set(pipelines.flatMap(missingStepKeys))];
  if (missing.length === 0) return { ok: true, catalog: {} };
  if (fetch === undefined) {
    return { ok: false, reason: "the server catalog isn't available here" };
  }
  return fetch(missing);
}

function validate(
  pipeline: BuiltPipeline,
  server: ServerCatalogResult,
): string[] {
  const unknown = missingStepKeys(pipeline);
  if (!server.ok && unknown.length > 0) {
    return unknown.map(
      (key) =>
        `Step "${key}" isn't defined in this directory, and the server's steps couldn't be read (${server.reason}). Define the step locally, or run \`scarn auth login\` so the build can check it against the server.`,
    );
  }
  const catalog = mergeCatalogs(
    pipeline.steps,
    server.ok ? server.catalog : {},
  );
  const result = validatePipeline(pipeline.document, catalog);
  return result.errors.map((error) =>
    formatLocatedValidationError(pipeline.sourceMap, error),
  );
}

function duplicateKeyErrors(reports: BuiltFileReport[]): void {
  const byPath = new Map<string, BuiltFileReport[]>();
  for (const report of reports) {
    if (report.jsonPath === undefined) continue;
    byPath.set(report.jsonPath, [
      ...(byPath.get(report.jsonPath) ?? []),
      report,
    ]);
  }
  for (const group of byPath.values()) {
    if (group.length < 2) continue;
    const sources = group.map((report) => basename(report.source)).join(", ");
    for (const report of group) {
      report.status = "failed";
      report.errors.push(
        `Pipeline "${report.key ?? ""}" is defined in more than one file (${sources}).`,
      );
    }
  }
}

export async function buildPipelineDocuments(
  options: BuildPipelineDocumentsOptions,
): Promise<BuildPipelineDocumentsResult> {
  const builderDir = resolve(options.builderDir);
  const check = options.check ?? false;
  const sources =
    options.files === undefined
      ? listPipelineSourceFiles(builderDir)
      : options.files.map((file) => resolve(file));

  const results = await runBuildScript(builderDir, sources);
  const built = results.flatMap((result) =>
    result.ok && result.pipeline ? [result.pipeline] : [],
  );
  const server = await serverCatalogFor(built, options.fetchServerCatalog);

  const reports: BuiltFileReport[] = [];
  for (const result of results) {
    if (!result.ok) {
      reports.push({
        source: result.file,
        status: "failed",
        errors: formatBuildFailure(result),
        warnings: [],
      });
      continue;
    }
    if (!result.pipeline) continue;
    const report = emit(result.pipeline, result.file, check);
    report.errors.push(...validate(result.pipeline, server));
    reports.push(report);
  }
  duplicateKeyErrors(reports);

  const ok = reports.every(
    (report) =>
      report.errors.length === 0 &&
      report.status !== "failed" &&
      report.status !== "missing" &&
      report.status !== "stale",
  );
  return { files: reports, ok };
}
