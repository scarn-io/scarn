import {
  appendWorkItemChange,
  type WorkItemChange,
} from "@scarn/sdk/contracts/work-item-changes";
import {
  loadCurrentExecutionInfo,
  type CurrentExecutionInfo,
  type WorkItemPermission,
} from "./current-execution";
import { resolveWorktree } from "./resolve-worktree";

export const RECORDED_CHANGE_NOTE =
  "Recorded. Nothing changes until this run succeeds; the server checks and applies recorded changes then.";

export const DEFERRED_DESCRIPTION_NOTE =
  "Nothing changes until this run succeeds: the change is recorded, then checked and applied by the server when the run completes.";

export const NO_WORK_ITEM_MESSAGE =
  "This run is not on a work item, so work item tools are unavailable.";

export function missingPermissionMessage(
  permission: WorkItemPermission,
): string {
  return `This Task lacks the \`${permission}\` work item permission.`;
}

export type WorkItemToolContext = {
  worktree: string;
  info: CurrentExecutionInfo & { workItemId: string };
};

/**
 * Loads the run's execution info for a work item tool, or a refusal message
 * when the run is not on a work item or the Task lacks `permission`.
 */
export async function loadWorkItemToolContext(
  directory: string,
  permission: WorkItemPermission,
): Promise<WorkItemToolContext | string> {
  const worktree = await resolveWorktree(directory);
  const info = await loadCurrentExecutionInfo(worktree);
  const { workItemId } = info;
  if (workItemId === null) {
    return NO_WORK_ITEM_MESSAGE;
  }
  if (!info.workItemPermissions.includes(permission)) {
    return missingPermissionMessage(permission);
  }
  return { worktree, info: { ...info, workItemId } };
}

/**
 * Validates the input into a change (or a refusal message) and appends it to
 * the run's recorded work item changes.
 */
export async function recordWorkItemChange(
  directory: string,
  buildChange: (context: WorkItemToolContext) => WorkItemChange | string,
): Promise<string> {
  const context = await loadWorkItemToolContext(directory, "self");
  if (typeof context === "string") {
    return context;
  }
  const change = buildChange(context);
  if (typeof change === "string") {
    return change;
  }
  await appendWorkItemChange(context.worktree, change);
  return RECORDED_CHANGE_NOTE;
}

// eslint-disable-next-line local/no-unknown-parameter-type -- a type guard
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function invalidInputMessage(detail: string): string {
  return `Invalid input: ${detail}`;
}
