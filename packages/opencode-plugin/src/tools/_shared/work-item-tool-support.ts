import {
  appendWorkItemChange,
  readWorkItemChanges,
  type WorkItemChange,
} from "@scarn/sdk/contracts/work-item-changes";
import { checkChangeGrants } from "./work-item-grants";
import {
  hasGrantFor,
  loadCurrentExecutionInfo,
  type CurrentExecutionInfo,
  type GrantAction,
  type WorkItemLinks,
} from "./current-execution";
import { resolveWorktree } from "./resolve-worktree";

export const RECORDED_CHANGE_NOTE =
  "Recorded. Nothing changes until this run succeeds; the server checks and applies recorded changes then.";

export const DEFERRED_DESCRIPTION_NOTE =
  "Nothing changes until this run succeeds: the change is recorded, then checked and applied by the server when the run completes.";

export const NO_WORK_ITEM_MESSAGE =
  "This run is not on a work item, so work item tools are unavailable.";

export function missingGrantMessage(action: GrantAction): string {
  return `This Task has no \`${action}\` grant on work items.`;
}

export type WorkItemToolContext = {
  worktree: string;
  info: CurrentExecutionInfo & { workItemId: string };
};

/**
 * Loads the run's execution info for a work item tool, or a refusal message
 * when the run is not on a work item or the Task has no grant for `action`.
 */
export async function loadWorkItemToolContext(
  directory: string,
  action: GrantAction,
): Promise<WorkItemToolContext | string> {
  const worktree = await resolveWorktree(directory);
  const info = await loadCurrentExecutionInfo(worktree);
  const { workItemId } = info;
  if (workItemId === null) {
    return NO_WORK_ITEM_MESSAGE;
  }
  if (!hasGrantFor(info.grants, action)) {
    return missingGrantMessage(action);
  }
  return { worktree, info: { ...info, workItemId } };
}

/**
 * Validates the input into a change (or a refusal message) and appends it to
 * the run's recorded work item changes, if the Task has a grant for `action`.
 */
export async function recordWorkItemChange(
  directory: string,
  action: GrantAction,
  buildChange: (context: WorkItemToolContext) => WorkItemChange | string,
): Promise<string> {
  const context = await loadWorkItemToolContext(directory, action);
  if (typeof context === "string") {
    return context;
  }
  const change = buildChange(context);
  if (typeof change === "string") {
    return change;
  }
  const refusal = await checkRecordedChange(context, change);
  if (refusal !== null) {
    return refusal;
  }
  await appendWorkItemChange(context.worktree, change);
  return RECORDED_CHANGE_NOTE;
}

/**
 * Refuses a change the server would refuse for lack of a grant, as far as the
 * plugin can tell from the run's grants and the changes recorded so far.
 */
export async function checkRecordedChange(
  context: WorkItemToolContext,
  change: WorkItemChange,
): Promise<string | null> {
  const recorded = await readWorkItemChanges(context.worktree);
  return checkChangeGrants(
    {
      grants: context.info.grants,
      ownWorkItemId: context.info.workItemId,
      createdWorkItemIds: new Set(
        recorded.flatMap((entry) =>
          entry.kind === "create" ? [entry.workItemId] : [],
        ),
      ),
    },
    change,
  );
}

// eslint-disable-next-line local/no-unknown-parameter-type -- a type guard
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

// eslint-disable-next-line local/no-unknown-parameter-type -- a type guard
export function isLabelList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isNonEmptyString);
}

/**
 * A work item's web page, `<appBaseUrl>/<projectPath>/work-items/<id>`, or
 * null when the worker gave no links. The only place these URLs are built.
 */
export function workItemUrl(
  links: WorkItemLinks | null,
  workItemId: string,
): string | null {
  if (links === null) {
    return null;
  }
  return `${links.appBaseUrl.replace(/\/+$/, "")}/${links.projectPath}/work-items/${encodeURIComponent(workItemId)}`;
}

export function invalidInputMessage(detail: string): string {
  return `Invalid input: ${detail}`;
}
