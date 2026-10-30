/**
 * The pure half of `scarn pipelines build`: what the build script reports
 * per source file, and turning that into located error lines. A validation
 * error's JSON pointer is mapped back to the TS creation site through the
 * pipeline's `sourceMap`, so every error prints like a build error:
 * `bug-repro.ts:42 (/nodes/review/next/routes/0/args/plan): message`.
 */
import type { StepCatalog } from "@scarn/sdk/contracts/pipeline-document";
import {
  formatIssue,
  type BuildIssue,
  type SourceSite,
} from "@scarn/sdk/pipelines";
import type { ValidationError } from "@scarn/shared-core/pipelines";

/** What a `definePipeline` default export carries across the process boundary. */
export type BuiltPipeline = {
  key: string;
  document: Record<string, unknown>;
  sourceMap: Record<string, SourceSite>;
  steps: StepCatalog;
  warnings: BuildIssue[];
};

/** One source file's outcome, as printed by `build-script.ts.tmpl`. */
export type BuildScriptResult =
  | { file: string; ok: true; pipeline?: BuiltPipeline }
  | { file: string; ok: false; message: string; issues?: BuildIssue[] };

/** The site of `pointer`, or of its closest ancestor in the source map. */
export function siteForPointer(
  sourceMap: Readonly<Record<string, SourceSite>>,
  pointer: string,
): SourceSite | null {
  let current = pointer;
  for (;;) {
    const site = sourceMap[current];
    if (site !== undefined) return site;
    if (current === "") return null;
    current = current.slice(0, current.lastIndexOf("/"));
  }
}

/** A validation error as `file.ts:42 (/pointer): message. hint`. */
export function formatLocatedValidationError(
  sourceMap: Readonly<Record<string, SourceSite>>,
  error: Pick<ValidationError, "path" | "message" | "hint">,
): string {
  return formatIssue({
    site: siteForPointer(sourceMap, error.path),
    pointer: error.path,
    message:
      error.hint === undefined
        ? error.message
        : `${error.message}. ${error.hint}`,
  });
}

/** The step keys a document's step nodes name, in document order. */
export function stepKeysOf(document: Record<string, unknown>): string[] {
  const nodes = document["nodes"];
  if (typeof nodes !== "object" || nodes === null) return [];
  const keys = new Set<string>();
  for (const node of Object.values(nodes as Record<string, unknown>)) {
    if (typeof node !== "object" || node === null) continue;
    const { kind, step } = node as { kind?: unknown; step?: unknown };
    if (kind === "step" && typeof step === "string") keys.add(step);
  }
  return [...keys];
}

/** Step keys the document uses that the pipeline's own handles don't define. */
export function missingStepKeys(pipeline: BuiltPipeline): string[] {
  return stepKeysOf(pipeline.document).filter(
    (key) => pipeline.steps[key] === undefined,
  );
}

/** The local catalog, plus server contracts for keys it doesn't have. */
export function mergeCatalogs(
  local: StepCatalog,
  server: StepCatalog,
): StepCatalog {
  return { ...server, ...local };
}

/** The lines a failed source file reports: its build issues, or its message. */
export function formatBuildFailure(
  result: Extract<BuildScriptResult, { ok: false }>,
): string[] {
  if (result.issues !== undefined && result.issues.length > 0) {
    return result.issues.map(formatIssue);
  }
  return [result.message];
}
