import { access, readFile } from "node:fs/promises";
import path from "node:path";

export const CURRENT_EXECUTION_INFO_RELATIVE_PATH =
  ".scarn/current-execution/execution.json";

export type CurrentExecutionInfo = {
  taskRunId: string;
  resultSchemaJson: Record<string, unknown> | null;
  /** How many more turns this step allows; `null` outside a run. */
  turnsRemaining: number | null;
};

/** Reads `.scarn/current-execution/execution.json` under the workspace. */
export async function loadCurrentExecutionInfo(
  worktree: string,
): Promise<CurrentExecutionInfo> {
  const currentExecutionInfoPath = path.join(
    worktree,
    CURRENT_EXECUTION_INFO_RELATIVE_PATH,
  );

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
      `Current execution metadata file at ${CURRENT_EXECUTION_INFO_RELATIVE_PATH} must contain a JSON object`,
    );
  }

  const parsedRecord = parsed as Record<string, unknown>;
  const taskRunId = parsedRecord["taskRunId"];
  const resultSchemaJson = parsedRecord["resultSchemaJson"];

  if (typeof taskRunId !== "string" || taskRunId.length === 0) {
    throw new Error(
      `Current execution metadata file at ${CURRENT_EXECUTION_INFO_RELATIVE_PATH} must contain a non-empty taskRunId`,
    );
  }

  if (
    resultSchemaJson !== null &&
    (typeof resultSchemaJson !== "object" || Array.isArray(resultSchemaJson))
  ) {
    throw new Error(
      `Current execution metadata file at ${CURRENT_EXECUTION_INFO_RELATIVE_PATH} must contain a JSON object or null resultSchemaJson`,
    );
  }

  const turnsRemaining = parsedRecord["turnsRemaining"];

  return {
    taskRunId,
    resultSchemaJson: resultSchemaJson as Record<string, unknown> | null,
    turnsRemaining:
      typeof turnsRemaining === "number" && Number.isInteger(turnsRemaining)
        ? turnsRemaining
        : null,
  };
}

/** Like {@link loadCurrentExecutionInfo}, but `null` when it can't be read. */
export async function tryLoadCurrentExecutionInfo(
  worktree: string,
): Promise<CurrentExecutionInfo | null> {
  try {
    return await loadCurrentExecutionInfo(worktree);
  } catch {
    return null;
  }
}
