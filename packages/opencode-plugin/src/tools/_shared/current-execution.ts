import { access, readFile } from "node:fs/promises";
import path from "node:path";

export const CURRENT_EXECUTION_INFO_RELATIVE_PATH =
  ".scarn/current-execution/execution.json";

export type CurrentExecutionInfo = {
  taskRunId: string;
  resultSchemaJson: Record<string, unknown> | null;
  /** How many more turns this step allows; `null` outside a run. */
  turnsRemaining: number | null;
  /** The work item the run's Task is on; `null` outside a run on one. */
  workItemId: string | null;
  workItemPermissions: WorkItemPermission[];
  /** How the agent's tools reach the API live; `null` when unavailable. */
  api: CurrentExecutionApi | null;
};

export type WorkItemPermission = "self" | "children";

export type CurrentExecutionApi = { baseUrl: string; claimToken: string };

const WORK_ITEM_PERMISSIONS: readonly WorkItemPermission[] = [
  "self",
  "children",
];

function parseWorkItemPermissions(
  record: Record<string, unknown>,
): WorkItemPermission[] {
  const value = record["workItemPermissions"];
  if (!Array.isArray(value)) {
    return [];
  }
  return WORK_ITEM_PERMISSIONS.filter((permission) =>
    value.includes(permission),
  );
}

function parseApi(record: Record<string, unknown>): CurrentExecutionApi | null {
  const value = record["api"];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const { baseUrl, claimToken } = value as Record<string, unknown>;
  if (
    typeof baseUrl !== "string" ||
    baseUrl.length === 0 ||
    typeof claimToken !== "string" ||
    claimToken.length === 0
  ) {
    return null;
  }
  return { baseUrl, claimToken };
}

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
  const workItemId = parsedRecord["workItemId"];

  return {
    taskRunId,
    resultSchemaJson: resultSchemaJson as Record<string, unknown> | null,
    turnsRemaining:
      typeof turnsRemaining === "number" && Number.isInteger(turnsRemaining)
        ? turnsRemaining
        : null,
    workItemId:
      typeof workItemId === "string" && workItemId.length > 0
        ? workItemId
        : null,
    workItemPermissions: parseWorkItemPermissions(parsedRecord),
    api: parseApi(parsedRecord),
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
