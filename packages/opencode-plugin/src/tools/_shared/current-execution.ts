import { access, readFile } from "node:fs/promises";
import path from "node:path";
import type { Grant, GrantAction, GrantScope } from "@scarn/sdk";

export const CURRENT_EXECUTION_INFO_RELATIVE_PATH =
  ".scarn/current-execution/execution.json";

export type CurrentExecutionInfo = {
  taskRunId: string;
  resultSchemaJson: Record<string, unknown> | null;
  /** How many more turns this step allows; `null` outside a run. */
  turnsRemaining: number | null;
  /** The work item the run's Task is on; `null` outside a run on one. */
  workItemId: string | null;
  /** What the run's Task may do to work items; `[]` when none were given. */
  grants: Grant[];
  /** How the agent's tools reach the API live; `null` when unavailable. */
  api: CurrentExecutionApi | null;
  /** What work item page URLs are built from; `null` when unknown. */
  workItemLinks: WorkItemLinks | null;
};

export type { Grant, GrantAction, GrantScope };

export type CurrentExecutionApi = { baseUrl: string; claimToken: string };

export type WorkItemLinks = { appBaseUrl: string; projectPath: string };

const GRANT_ACTIONS: readonly GrantAction[] = [
  "read",
  "update",
  "comment",
  "label",
  "block",
  "close",
  "create",
];

const GRANT_SCOPES: readonly GrantScope[] = ["self", "children"];

// eslint-disable-next-line local/no-unknown-parameter-type -- a parser
function parseLabels(value: unknown): string[] | null {
  return Array.isArray(value) &&
    value.every((label) => typeof label === "string")
    ? [...value]
    : null;
}

// eslint-disable-next-line local/no-unknown-parameter-type -- a parser
function parseGrant(value: unknown): Grant | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const { resource, action, scope, labels } = value as Record<string, unknown>;
  const knownAction = GRANT_ACTIONS.find((candidate) => candidate === action);
  const knownScope = GRANT_SCOPES.find((candidate) => candidate === scope);
  if (
    resource !== "workItem" ||
    knownAction === undefined ||
    knownScope === undefined
  ) {
    return null;
  }
  if (knownAction === "create") {
    const parsedLabels = parseLabels(labels);
    return knownScope === "children" && parsedLabels !== null
      ? {
          resource,
          action: knownAction,
          scope: knownScope,
          labels: parsedLabels,
        }
      : null;
  }
  if (knownAction === "label") {
    const parsedLabels = parseLabels(labels);
    return parsedLabels === null
      ? null
      : {
          resource,
          action: knownAction,
          scope: knownScope,
          labels: parsedLabels,
        };
  }
  return { resource, action: knownAction, scope: knownScope };
}

function parseGrants(record: Record<string, unknown>): Grant[] {
  const value = record["grants"];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    const grant = parseGrant(entry);
    return grant === null ? [] : [grant];
  });
}

/** Whether `grants` hold `action` on any scope. */
export function hasGrantFor(
  grants: readonly Grant[],
  action: GrantAction,
): boolean {
  return grants.some((grant) => grant.action === action);
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

function parseWorkItemLinks(
  record: Record<string, unknown>,
): WorkItemLinks | null {
  const value = record["workItemLinks"];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const { appBaseUrl, projectPath } = value as Record<string, unknown>;
  if (
    typeof appBaseUrl !== "string" ||
    appBaseUrl.length === 0 ||
    typeof projectPath !== "string" ||
    projectPath.length === 0
  ) {
    return null;
  }
  return { appBaseUrl, projectPath };
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
    grants: parseGrants(parsedRecord),
    api: parseApi(parsedRecord),
    workItemLinks: parseWorkItemLinks(parsedRecord),
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
