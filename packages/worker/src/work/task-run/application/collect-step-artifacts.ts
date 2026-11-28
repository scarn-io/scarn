import { access, readdir, stat } from "node:fs/promises";
import path from "node:path";
import {
  findSubmittableArtifactFieldsWithProblems,
  readStepArtifactSubmissions,
  type SubmittedArtifact,
} from "@scarn/sdk/contracts/step-artifact-submissions";
import type { AnyJsonValue } from "../../../common/contracts/json";
import type { startProcessClaimedTaskRun } from "./process-claimed-task-run";
import type { resolveProjectWorkLogger } from "./process-project-work-logger";
import type { ProcessProjectWorkDeps } from "../contracts/process-project-work-types";
import { tryReadCurrentExecutionInfo } from "./process-project-work-findings";
import { detectArtifactKind } from "../../../artifacts/artifact-store/domain/detect-artifact-kind";
import { classifyArtifactSaveError } from "../../../artifacts/artifact-store/domain/classify-artifact-save-error";
import {
  saveArtifactBundle,
  type ArtifactBundleMember,
} from "../../../artifacts/artifact-store/domain/artifact-store";

type StartedTask = Awaited<ReturnType<typeof startProcessClaimedTaskRun>>;
type Logger = ReturnType<typeof resolveProjectWorkLogger>;

/** A folder under step-artifacts to save as one bundle. */
export type PlannedBundle = {
  name: string;
  /** Relative to the step-artifacts folder, POSIX, no trailing slash. */
  rootPath: string;
  entryPath: string;
  fieldPath?: string | undefined;
};

type StepArtifactFile = {
  relativeStorePath: string;
  sourcePath: string;
  sizeBytes: number;
};

type FailureContext = {
  deps: ProcessProjectWorkDeps;
  startedTask: StartedTask;
  logger: Logger;
};

/**
 * Saves everything under `.scarn/step-artifacts`. Folders submitted as
 * bundles (in `artifacts.json`, or a code step's bundle field in
 * `findingsJson`) are saved as one bundle each; every other file is saved on
 * its own. Never throws for a save failure: each one is logged and reported
 * through `recordArtifactFailure`.
 */
export async function collectStepArtifacts(
  deps: ProcessProjectWorkDeps,
  startedTask: StartedTask,
  logger: Logger,
  options?: { findingsJson?: AnyJsonValue | undefined },
): Promise<void> {
  const workspacePath = startedTask.environment.workspacePath;
  const stepArtifactsDir = path.join(workspacePath, ".scarn", "step-artifacts");

  try {
    await access(stepArtifactsDir);
  } catch {
    return;
  }

  const bundles = await planStepArtifactBundles({
    workspacePath,
    stepArtifactsDir,
    findingsJson: options?.findingsJson,
    logger,
    taskRunId: startedTask.taskRunId,
  });
  const files = await listStepArtifactFiles(stepArtifactsDir);
  const members = new Map<PlannedBundle, StepArtifactFile[]>(
    bundles.map((bundle) => [bundle, []]),
  );
  const context: FailureContext = { deps, startedTask, logger };

  for (const file of files) {
    const bundle = bundles.find((candidate) =>
      file.relativeStorePath.startsWith(`${candidate.rootPath}/`),
    );
    if (bundle) {
      members.get(bundle)?.push(file);
      continue;
    }
    await saveLooseFile(context, file);
  }

  for (const [bundle, bundleFiles] of members) {
    await saveBundle(context, bundle, bundleFiles);
  }

  try {
    await deps.artifactStore.prune?.();
  } catch (error) {
    logger.error("worker", "Failed to prune local artifacts", {
      taskRunId: startedTask.taskRunId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * The bundles to save: each `kind: "bundle"` submission in `artifacts.json`,
 * plus each bundle field whose findings value names a folder (how a code step
 * fills one with `Artifact.path(...)`). Unreadable inputs are logged and
 * skipped, so their files are saved one by one instead.
 */
export async function planStepArtifactBundles(input: {
  workspacePath: string;
  stepArtifactsDir: string;
  findingsJson: AnyJsonValue | undefined;
  logger: Logger;
  taskRunId: string;
}): Promise<PlannedBundle[]> {
  const planned = new Map<string, PlannedBundle>();
  const add = (bundle: PlannedBundle) => {
    if (!planned.has(bundle.rootPath)) planned.set(bundle.rootPath, bundle);
  };

  try {
    const submissions = await readStepArtifactSubmissions(input.workspacePath);
    for (const [fieldPath, submitted] of Object.entries(submissions.fields)) {
      const bundle = bundleFromSubmission(submitted, fieldPath);
      if (bundle) add(bundle);
    }
    for (const submitted of submissions.extra) {
      const bundle = bundleFromSubmission(submitted, undefined);
      if (bundle) add(bundle);
    }
  } catch (error) {
    input.logger.error("worker", "Failed to read submitted step artifacts", {
      taskRunId: input.taskRunId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  if (input.findingsJson !== undefined) {
    for (const bundle of await bundlesFromFindings(input)) add(bundle);
  }

  return [...planned.values()];
}

function bundleFromSubmission(
  submitted: SubmittedArtifact,
  fieldPath: string | undefined,
): PlannedBundle | null {
  if (submitted.kind !== "bundle") return null;
  const rootPath = trimTrailingSlashes(submitted.stored);
  return {
    name: fieldPath ?? rootPath,
    rootPath,
    entryPath: submitted.entry,
    ...(fieldPath === undefined ? {} : { fieldPath }),
  };
}

async function bundlesFromFindings(input: {
  workspacePath: string;
  stepArtifactsDir: string;
  findingsJson: AnyJsonValue | undefined;
}): Promise<PlannedBundle[]> {
  const info = await tryReadCurrentExecutionInfo(input.workspacePath);
  const { fields, problems } = findSubmittableArtifactFieldsWithProblems(
    info?.resultSchemaJson,
  );
  if (problems.length > 0) return [];

  const bundles: PlannedBundle[] = [];
  for (const field of fields) {
    if (!field.bundle) continue;
    const value = readFindingsPath(input.findingsJson, field.path.split("."));
    if (typeof value !== "string" || value.length === 0) continue;
    const rootPath = trimTrailingSlashes(path.posix.normalize(value));
    if (
      rootPath === "." ||
      rootPath.startsWith("..") ||
      rootPath.startsWith("/")
    ) {
      continue;
    }
    const folder = await stat(
      path.join(input.stepArtifactsDir, rootPath),
    ).catch(() => null);
    if (!folder?.isDirectory()) continue;
    bundles.push({
      name: field.path,
      rootPath,
      entryPath: field.bundle.entry,
      fieldPath: field.path,
    });
  }
  return bundles;
}

function readFindingsPath(
  root: AnyJsonValue | undefined,
  segments: readonly string[],
): AnyJsonValue | undefined {
  let current = root;
  for (const segment of segments) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

async function listStepArtifactFiles(
  stepArtifactsDir: string,
): Promise<StepArtifactFile[]> {
  const entries = await readdir(stepArtifactsDir, { recursive: true });
  const files: StepArtifactFile[] = [];
  for (const entry of entries) {
    const sourcePath = path.join(stepArtifactsDir, entry);
    const fileStat = await stat(sourcePath);
    if (!fileStat.isFile()) continue;
    files.push({
      relativeStorePath: entry.split(path.sep).join("/"),
      sourcePath,
      sizeBytes: fileStat.size,
    });
  }
  return files;
}

async function saveLooseFile(
  context: FailureContext,
  file: StepArtifactFile,
): Promise<void> {
  const { deps, startedTask, logger } = context;
  const { relativeStorePath, sourcePath } = file;
  logger.log("worker", "Saving step artifact", {
    taskRunId: startedTask.taskRunId,
    relativeStorePath,
    sourcePath,
  });

  const kind = await detectArtifactKind(relativeStorePath, sourcePath);

  try {
    const result = await deps.artifactStore.saveArtifact({
      taskRunId: startedTask.taskRunId,
      claimToken: startedTask.claimToken,
      sourcePath,
      relativeStorePath,
      kind,
    });
    logger.log("worker", "Saved step artifact", {
      taskRunId: startedTask.taskRunId,
      relativeStorePath,
      storeRef: result.storeRef,
      sizeBytes: result.sizeBytes,
    });
  } catch (error) {
    logger.error("worker", "Failed to save step artifact", {
      taskRunId: startedTask.taskRunId,
      relativeStorePath,
      sourcePath,
      error: error instanceof Error ? error.message : String(error),
    });
    await reportFailure(context, {
      relativeStorePath,
      attemptedSizeBytes: file.sizeBytes,
      kind,
      error,
    });
  }
}

async function saveBundle(
  context: FailureContext,
  bundle: PlannedBundle,
  files: readonly StepArtifactFile[],
): Promise<void> {
  const { deps, startedTask, logger } = context;
  const attemptedSizeBytes = files.reduce(
    (sum, file) => sum + file.sizeBytes,
    0,
  );
  logger.log("worker", "Saving step artifact bundle", {
    taskRunId: startedTask.taskRunId,
    bundle: bundle.name,
    rootPath: bundle.rootPath,
    fileCount: files.length,
  });

  try {
    const members: ArtifactBundleMember[] = await Promise.all(
      files.map(async (file) => ({
        path: file.relativeStorePath.slice(bundle.rootPath.length + 1),
        sourcePath: file.sourcePath,
        sizeBytes: file.sizeBytes,
        kind: await detectArtifactKind(file.relativeStorePath, file.sourcePath),
      })),
    );
    const result = await saveArtifactBundle(deps.artifactStore, {
      taskRunId: startedTask.taskRunId,
      claimToken: startedTask.claimToken,
      name: bundle.name,
      rootPath: bundle.rootPath,
      entryPath: bundle.entryPath,
      ...(bundle.fieldPath === undefined
        ? {}
        : { fieldPath: bundle.fieldPath }),
      members,
    });
    logger.log("worker", "Saved step artifact bundle", {
      taskRunId: startedTask.taskRunId,
      bundle: bundle.name,
      storeRef: result.storeRef,
      sizeBytes: result.sizeBytes,
      fileCount: result.fileCount,
    });
  } catch (error) {
    logger.error("worker", "Failed to save step artifact bundle", {
      taskRunId: startedTask.taskRunId,
      bundle: bundle.name,
      rootPath: bundle.rootPath,
      error: error instanceof Error ? error.message : String(error),
    });
    await reportFailure(context, {
      relativeStorePath: bundle.rootPath,
      attemptedSizeBytes,
      error,
      messagePrefix: `Bundle ${bundle.name}: `,
    });
  }
}

async function reportFailure(
  { deps, startedTask, logger }: FailureContext,
  failure: {
    relativeStorePath: string;
    attemptedSizeBytes: number;
    kind?: Awaited<ReturnType<typeof detectArtifactKind>> | undefined;
    error: unknown;
    messagePrefix?: string | undefined;
  },
): Promise<void> {
  try {
    const classified = classifyArtifactSaveError(failure.error);
    await deps.workerClient.recordArtifactFailure({
      taskRunId: startedTask.taskRunId,
      claimToken: startedTask.claimToken,
      relativeStorePath: failure.relativeStorePath,
      attemptedSizeBytes: failure.attemptedSizeBytes,
      ...(failure.kind === undefined ? {} : { kind: failure.kind }),
      errorCode: classified.errorCode,
      errorMessage: `${failure.messagePrefix ?? ""}${classified.errorMessage}`,
      ...(classified.httpStatus === null
        ? {}
        : { httpStatus: classified.httpStatus }),
    });
  } catch (reportingError) {
    logger.error("worker", "Failed to report step artifact save failure", {
      taskRunId: startedTask.taskRunId,
      relativeStorePath: failure.relativeStorePath,
      error:
        reportingError instanceof Error
          ? reportingError.message
          : String(reportingError),
    });
  }
}
