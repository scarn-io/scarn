import Ajv from "ajv/dist/2020";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { ARTIFACT_SCHEMA_KEYWORD } from "@scarn/sdk/contracts/artifacts";
import {
  applyArtifactSubmissions,
  checkReturnedArtifactPaths,
  checkSubmittedArtifactFiles,
  findSubmittableArtifactFields,
  readStepArtifactSubmissions,
} from "@scarn/sdk/contracts/step-artifact-submissions";
import type { AnyJsonValue } from "../../../common/contracts/json";
import type {
  CommitAndPushWorkBranchResult,
  ProcessProjectWorkDeps,
  StartedClaimedTask,
} from "../contracts/process-project-work-types";

const STEP_FINDINGS_SUBMISSION_RELATIVE_PATH =
  ".scarn/step-findings-submission.json";
const CURRENT_EXECUTION_DIRECTORY_RELATIVE_PATH = ".scarn/current-execution";
const CURRENT_EXECUTION_INFO_RELATIVE_PATH = `${CURRENT_EXECUTION_DIRECTORY_RELATIVE_PATH}/execution.json`;
const CURRENT_EXECUTION_GITIGNORE_RELATIVE_PATH = `${CURRENT_EXECUTION_DIRECTORY_RELATIVE_PATH}/.gitignore`;
const CURRENT_EXECUTION_GITIGNORE_CONTENT = "*\n.*\n!.gitignore\n";

export type CurrentExecutionInfo = {
  taskRunId: string;
  resultSchemaJson: Record<string, unknown> | null;
  /** How many more times the agent may hand the conversation to a person; `null` outside a run. */
  turnsRemaining: number | null;
};

export function buildFindingsSubmissionPath(workspacePath: string): string {
  return path.join(workspacePath, STEP_FINDINGS_SUBMISSION_RELATIVE_PATH);
}

export function buildCurrentExecutionInfoPath(workspacePath: string): string {
  return path.join(workspacePath, CURRENT_EXECUTION_INFO_RELATIVE_PATH);
}

/**
 * Delete any leftover findings submission file from the workspace. A step's
 * work branch is cloned from the previous step's branch, which may carry a
 * committed `.scarn/step-findings-submission.json` from that earlier step.
 * If left in place, the monitor's first poll (before the agent starts) reads
 * the stale file and validates it against THIS step's schema, failing the step
 * before the agent has done anything. Called during workspace setup to
 * guarantee a clean slate regardless of git history. Best-effort: `force`
 * makes a missing file a no-op.
 */
export async function removeFindingsSubmissionFile(
  workspacePath: string,
): Promise<void> {
  await rm(buildFindingsSubmissionPath(workspacePath), { force: true });
}

export async function writeCurrentExecutionInfoFile(
  workspacePath: string,
  input: CurrentExecutionInfo,
): Promise<string> {
  const currentExecutionInfoPath = buildCurrentExecutionInfoPath(workspacePath);
  await mkdir(path.dirname(currentExecutionInfoPath), { recursive: true });
  await writeFile(
    path.join(workspacePath, CURRENT_EXECUTION_GITIGNORE_RELATIVE_PATH),
    CURRENT_EXECUTION_GITIGNORE_CONTENT,
    "utf8",
  );
  await writeFile(
    currentExecutionInfoPath,
    `${JSON.stringify(
      {
        taskRunId: input.taskRunId,
        resultSchemaJson: input.resultSchemaJson,
        turnsRemaining: input.turnsRemaining,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return currentExecutionInfoPath;
}

async function tryReadFindingsSubmission(
  workspacePath: string,
): Promise<Record<string, unknown> | null> {
  const submissionPath = buildFindingsSubmissionPath(workspacePath);

  try {
    await access(submissionPath);
  } catch {
    return null;
  }

  const rawPayload = await readFile(submissionPath, "utf8");
  const parsed: unknown = JSON.parse(rawPayload);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

async function readCurrentExecutionInfo(
  workspacePath: string,
): Promise<CurrentExecutionInfo> {
  const currentExecutionInfoPath = buildCurrentExecutionInfoPath(workspacePath);

  try {
    await access(currentExecutionInfoPath);
  } catch {
    throw new Error(
      `Current execution metadata file not found at ${currentExecutionInfoPath}`,
    );
  }

  const rawPayload = await readFile(currentExecutionInfoPath, "utf8");
  const parsed: unknown = JSON.parse(rawPayload);

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `Current execution metadata file at ${currentExecutionInfoPath} must contain a JSON object`,
    );
  }

  const parsedRecord = parsed as Record<string, unknown>;
  const taskRunId = parsedRecord["taskRunId"];
  const resultSchemaJson = parsedRecord["resultSchemaJson"];

  if (typeof taskRunId !== "string" || taskRunId.length === 0) {
    throw new Error(
      `Current execution metadata file at ${currentExecutionInfoPath} must contain a non-empty taskRunId`,
    );
  }

  if (
    resultSchemaJson !== null &&
    (typeof resultSchemaJson !== "object" || Array.isArray(resultSchemaJson))
  ) {
    throw new Error(
      `Current execution metadata file at ${currentExecutionInfoPath} must contain a JSON object or null resultSchemaJson`,
    );
  }

  const turnsRemaining = parsedRecord["turnsRemaining"];

  return {
    taskRunId,
    resultSchemaJson: resultSchemaJson as Record<string, unknown> | null,
    turnsRemaining: typeof turnsRemaining === "number" ? turnsRemaining : null,
  };
}

/** Like `readCurrentExecutionInfo`, but `null` when it can't be read. */
export async function tryReadCurrentExecutionInfo(
  workspacePath: string,
): Promise<CurrentExecutionInfo | null> {
  try {
    return await readCurrentExecutionInfo(workspacePath);
  } catch {
    return null;
  }
}

/**
 * How a step's declared artifact fields were filled: by the plugin from
 * `artifacts.json` (an agent step), or by the step function returning
 * `Artifact.path(...)` values (a code step).
 */
type ArtifactFieldSource = "submissions" | "returned";

async function checkArtifactFields(
  findings: AnyJsonValue,
  resultSchemaJson: Record<string, unknown>,
  workspacePath: string,
  source: ArtifactFieldSource,
): Promise<string[]> {
  const fields = findSubmittableArtifactFields(resultSchemaJson);
  if (fields.length === 0) return [];

  if (source === "returned") {
    return checkReturnedArtifactPaths({ workspacePath, fields, findings });
  }

  const submissions = await readStepArtifactSubmissions(workspacePath);
  const verified = applyArtifactSubmissions({
    findings,
    fields,
    submissions,
    mode: "verify",
  });
  return [
    ...verified.problems,
    ...(await checkSubmittedArtifactFiles({
      workspacePath,
      fields,
      submissions,
    })),
  ];
}

async function validateFindingsAgainstSchema(
  findings: AnyJsonValue,
  resultSchemaJson: Record<string, unknown> | null,
  workspacePath: string,
  artifactSource: ArtifactFieldSource,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!resultSchemaJson) {
    return {
      ok: false,
      reason:
        "This step is a conversation and has no result schema, so it takes no findings; it ends through scarn-end-conversation.",
    };
  }

  const ajv = new Ajv({ allErrors: true, strict: false });
  ajv.addKeyword(ARTIFACT_SCHEMA_KEYWORD);
  let validate: ReturnType<Ajv["compile"]>;
  try {
    validate = ajv.compile(resultSchemaJson);
  } catch (error) {
    return {
      ok: false,
      reason: `Step definition resultSchemaJson is invalid: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  const problems = await checkArtifactFields(
    findings,
    resultSchemaJson,
    workspacePath,
    artifactSource,
  );

  if (!validate(findings)) {
    const details = (validate.errors ?? [])
      .map(
        (issue) => `${issue.instancePath || "/"} ${issue.message ?? "invalid"}`,
      )
      .join("; ");
    problems.unshift(
      `findingsJson does not match resultSchemaJson: ${details || "validation failed"}`,
    );
  }

  return problems.length === 0
    ? { ok: true }
    : { ok: false, reason: problems.join("\n") };
}

export type TryPersistAgentFindingsOptions = {
  /**
   * Best-effort hook invoked ONLY on the success path — after findings have
   * been validated and immediately BEFORE the task is completed
   * (which transitions the step out of "running"). Used to collect step
   * artifacts while the artifact API still accepts uploads for a running step.
   *
   * Receives the validated `findingsJson`, which the work-branch commit renders
   * into its message.
   *
   * The callback owns its own best-effort/error-swallowing semantics; this
   * function calls it directly and does not wrap it, so a thrown error here
   * WILL propagate and abort completion. `collectStepArtifacts` is non-throwing
   * by design; a failed work-branch push under `onPushFailure: "fail"` throws
   * on purpose, which fails the step instead of completing it.
   *
   * May resolve the work-branch push outcome. `{ pushed: false }` (a failed
   * push under `"warn"`) makes completion report no `workBranch`; resolving
   * nothing means no push was attempted.
   */
  onBeforeComplete?: (ctx: {
    findingsJson: AnyJsonValue;
  }) => Promise<CommitAndPushWorkBranchResult | undefined>;
};

export async function tryPersistAgentFindings(
  deps: ProcessProjectWorkDeps,
  startedTask: StartedClaimedTask,
  options?: TryPersistAgentFindingsOptions,
): Promise<"submitted" | "missing"> {
  const parsedPayload = await tryReadFindingsSubmission(
    startedTask.environment.workspacePath,
  );

  if (!parsedPayload) {
    return "missing";
  }

  const currentExecutionInfo = await readCurrentExecutionInfo(
    startedTask.environment.workspacePath,
  );

  if (currentExecutionInfo.taskRunId !== startedTask.taskRunId) {
    throw new Error(
      `Current execution metadata taskRunId ${currentExecutionInfo.taskRunId} does not match running task ${startedTask.taskRunId}`,
    );
  }

  const findingsJson = parsedPayload["findingsJson"] as AnyJsonValue;
  const validation = await validateFindingsAgainstSchema(
    findingsJson,
    currentExecutionInfo.resultSchemaJson,
    startedTask.environment.workspacePath,
    startedTask.environment.agent ? "submissions" : "returned",
  );

  if (!validation.ok) {
    throw new Error(validation.reason);
  }

  // Collect artifacts (best-effort) while the step is still "running", i.e.
  // before completion transitions it out of "running" and the artifact API
  // starts rejecting uploads with TASK_OWNERSHIP_CONFLICT.
  const beforeComplete = await options?.onBeforeComplete?.({ findingsJson });
  const pushFailed = beforeComplete?.pushed === false;

  await deps.workerClient.completeTaskRun({
    taskRunId: startedTask.taskRunId,
    claimToken: startedTask.claimToken,
    resultJson: findingsJson,
    errorJson: null,
    // Dedicated fields (NOT inside resultJson): the work branch the agent
    // committed to and the branch it was created off of. The work branch is
    // null for no_workspace runs, runs without a step key, and when its push
    // failed under onPushFailure "warn" (the next step would otherwise be
    // handed a base that is not on the remote).
    workBranch: pushFailed ? null : startedTask.environment.workBranch,
    createdFromBranch: startedTask.environment.createdFromBranch,
    sessionRestored: startedTask.sessionRestored ?? null,
  });

  await rm(buildFindingsSubmissionPath(startedTask.environment.workspacePath), {
    force: true,
  });
  return "submitted";
}
