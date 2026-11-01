import type { Info as ToolInfo } from "@opencode/plugin/promise/tool";
import {
  appendWorkItemChange,
  MAX_WORK_ITEMS_CREATED_PER_RUN,
  readWorkItemChanges,
} from "@scarn/sdk/contracts/work-item-changes";
import {
  DEFERRED_DESCRIPTION_NOTE,
  invalidInputMessage,
  isNonEmptyString,
  loadWorkItemToolContext,
} from "./_shared/work-item-tool-support";

export const SCARN_CREATE_WORK_ITEM_TOOL = "scarn-create-work-item";

export const CREATE_LIMIT_REACHED_MESSAGE = `This run has already created ${String(MAX_WORK_ITEMS_CREATED_PER_RUN)} work items, the most one run may create.`;

export type CreateWorkItemInput = {
  title?: unknown;
  description?: unknown;
  fields?: unknown;
  blockedBy?: unknown;
};

/**
 * Records a new child of the Task's work item. The id is generated here so
 * later calls in the same run can refer to the item before it exists.
 */
export async function createWorkItem(
  input: CreateWorkItemInput,
  directory: string,
): Promise<string> {
  const context = await loadWorkItemToolContext(directory, "children");
  if (typeof context === "string") {
    return context;
  }
  const { title, description, fields, blockedBy } = input;
  if (!isNonEmptyString(title)) {
    return invalidInputMessage("`title` must be a non-empty string.");
  }
  if (typeof description !== "string") {
    return invalidInputMessage("`description` must be a string.");
  }
  if (
    fields !== undefined &&
    (fields === null || typeof fields !== "object" || Array.isArray(fields))
  ) {
    return invalidInputMessage("`fields` must be a JSON object.");
  }
  if (
    blockedBy !== undefined &&
    (!Array.isArray(blockedBy) || !blockedBy.every(isNonEmptyString))
  ) {
    return invalidInputMessage(
      "`blockedBy` must be an array of work item ids.",
    );
  }

  const changes = await readWorkItemChanges(context.worktree);
  const createdCount = changes.filter(
    (change) => change.kind === "create",
  ).length;
  if (createdCount >= MAX_WORK_ITEMS_CREATED_PER_RUN) {
    return CREATE_LIMIT_REACHED_MESSAGE;
  }

  const workItemId = Bun.randomUUIDv7();
  await appendWorkItemChange(context.worktree, {
    kind: "create",
    workItemId,
    title,
    description,
    ...(fields === undefined
      ? {}
      : { fields: fields as Record<string, unknown> }),
    ...(blockedBy === undefined ? {} : { blockedBy }),
  });
  return JSON.stringify({
    workItemId,
    note: "Recorded. The item is created only when this run succeeds; use this workItemId to refer to it in later calls.",
  });
}

/** The `scarn-create-work-item` tool, bound to the plugin's directory. */
export function createScarnCreateWorkItemTool(directory: string): ToolInfo {
  return {
    name: SCARN_CREATE_WORK_ITEM_TOOL,
    description: `Create a work item as a child of this Task's work item. Returns the new item's workItemId, which you can use right away in other work item tools (e.g. as a blocker). At most ${String(MAX_WORK_ITEMS_CREATED_PER_RUN)} per run. ${DEFERRED_DESCRIPTION_NOTE}`,
    input: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short title of the new item" },
        description: {
          type: "string",
          description: "Markdown description of the new item",
        },
        fields: {
          type: "object",
          description: "Optional custom field values",
        },
        blockedBy: {
          type: "array",
          items: { type: "string" },
          description: "Ids of work items that block the new item",
        },
      },
      required: ["title", "description"],
    },
    options: { codemode: false },
    execute: async (input) => ({
      content: await createWorkItem(input as CreateWorkItemInput, directory),
    }),
  };
}
