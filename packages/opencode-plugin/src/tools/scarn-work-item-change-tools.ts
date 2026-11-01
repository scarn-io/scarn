import type { Info as ToolInfo } from "@opencode/plugin/promise/tool";
import {
  WORK_ITEM_CLOSE_REASONS,
  type WorkItemChange,
  type WorkItemCloseReason,
} from "@scarn/sdk/contracts/work-item-changes";
import {
  DEFERRED_DESCRIPTION_NOTE,
  invalidInputMessage,
  isNonEmptyString,
  recordWorkItemChange,
} from "./_shared/work-item-tool-support";

/**
 * The work item tools that only record a change for the server to apply when
 * the run succeeds: block, describe, comment, close and start-task.
 */

export const SCARN_BLOCK_WORK_ITEM_TOOL = "scarn-block-work-item";
export const SCARN_SET_WORK_ITEM_DESCRIPTION_TOOL =
  "scarn-set-work-item-description";
export const SCARN_COMMENT_ON_WORK_ITEM_TOOL = "scarn-comment-on-work-item";
export const SCARN_CLOSE_WORK_ITEM_TOOL = "scarn-close-work-item";
export const SCARN_START_TASK_TOOL = "scarn-start-task";

type ToolInput = Record<string, unknown>;

const WORK_ITEM_ID_MESSAGE = invalidInputMessage(
  "`workItemId` must be a non-empty string.",
);

export function buildBlockChange(input: ToolInput): WorkItemChange | string {
  const { blockedWorkItemId, blockingWorkItemId, remove } = input;
  if (
    !isNonEmptyString(blockedWorkItemId) ||
    !isNonEmptyString(blockingWorkItemId)
  ) {
    return invalidInputMessage(
      "`blockedWorkItemId` and `blockingWorkItemId` must be non-empty strings.",
    );
  }
  if (blockedWorkItemId === blockingWorkItemId) {
    return invalidInputMessage("A work item cannot block itself.");
  }
  if (remove !== undefined && typeof remove !== "boolean") {
    return invalidInputMessage("`remove` must be a boolean.");
  }
  return {
    kind: "block",
    blockedWorkItemId,
    blockingWorkItemId,
    ...(remove ? { remove: true } : {}),
  };
}

export function buildDescribeChange(input: ToolInput): WorkItemChange | string {
  const { workItemId, description, descriptionVersion } = input;
  if (!isNonEmptyString(workItemId)) {
    return WORK_ITEM_ID_MESSAGE;
  }
  if (typeof description !== "string") {
    return invalidInputMessage("`description` must be a string.");
  }
  if (
    typeof descriptionVersion !== "number" ||
    !Number.isInteger(descriptionVersion) ||
    descriptionVersion < 1
  ) {
    return invalidInputMessage(
      "`descriptionVersion` must be a positive integer from scarn-get-work-item.",
    );
  }
  return { kind: "describe", workItemId, description, descriptionVersion };
}

export function buildCommentChange(input: ToolInput): WorkItemChange | string {
  const { workItemId, body } = input;
  if (!isNonEmptyString(workItemId)) {
    return WORK_ITEM_ID_MESSAGE;
  }
  if (!isNonEmptyString(body)) {
    return invalidInputMessage("`body` must be a non-empty string.");
  }
  return { kind: "comment", workItemId, body };
}

// eslint-disable-next-line local/no-unknown-parameter-type -- a type guard
function isCloseReason(value: unknown): value is WorkItemCloseReason {
  return (WORK_ITEM_CLOSE_REASONS as readonly unknown[]).includes(value);
}

export function buildCloseChange(input: ToolInput): WorkItemChange | string {
  const { workItemId, reason, resolution } = input;
  if (!isNonEmptyString(workItemId)) {
    return WORK_ITEM_ID_MESSAGE;
  }
  if (!isCloseReason(reason)) {
    return invalidInputMessage(
      `\`reason\` must be one of ${WORK_ITEM_CLOSE_REASONS.join(", ")}.`,
    );
  }
  if (
    resolution !== undefined &&
    resolution !== null &&
    typeof resolution !== "string"
  ) {
    return invalidInputMessage("`resolution` must be a string.");
  }
  return {
    kind: "close",
    workItemId,
    reason,
    resolution: resolution ?? null,
  };
}

export function buildStartTaskChange(
  input: ToolInput,
): WorkItemChange | string {
  const { workItemId, stepDefinitionKey } = input;
  if (!isNonEmptyString(workItemId)) {
    return WORK_ITEM_ID_MESSAGE;
  }
  if (!isNonEmptyString(stepDefinitionKey)) {
    return invalidInputMessage(
      "`stepDefinitionKey` must be a non-empty string.",
    );
  }
  return { kind: "startTask", workItemId, stepKey: stepDefinitionKey };
}

function createChangeTool(
  directory: string,
  name: string,
  description: string,
  input: ToolInfo["input"],
  buildChange: (input: ToolInput) => WorkItemChange | string,
): ToolInfo {
  return {
    name,
    description: `${description} ${DEFERRED_DESCRIPTION_NOTE}`,
    input,
    options: { codemode: false },
    execute: async (toolInput) => ({
      content: await recordWorkItemChange(directory, () =>
        buildChange(toolInput as ToolInput),
      ),
    }),
  };
}

const workItemIdProperty = {
  type: "string",
  description: "Id of the work item",
};

export function createScarnBlockWorkItemTool(directory: string): ToolInfo {
  return createChangeTool(
    directory,
    SCARN_BLOCK_WORK_ITEM_TOOL,
    "Add a block between two work items (the blocking item must be closed before the blocked one is ready), or remove one with `remove: true`.",
    {
      type: "object",
      properties: {
        blockedWorkItemId: {
          type: "string",
          description: "Id of the work item that is blocked",
        },
        blockingWorkItemId: {
          type: "string",
          description: "Id of the work item that blocks it",
        },
        remove: {
          type: "boolean",
          description: "Remove the block instead of adding it",
        },
      },
      required: ["blockedWorkItemId", "blockingWorkItemId"],
    },
    buildBlockChange,
  );
}

export function createScarnSetWorkItemDescriptionTool(
  directory: string,
): ToolInfo {
  return createChangeTool(
    directory,
    SCARN_SET_WORK_ITEM_DESCRIPTION_TOOL,
    "Replace a work item's description. Pass the `descriptionVersion` you read with scarn-get-work-item; the write is rejected if the description changed since.",
    {
      type: "object",
      properties: {
        workItemId: workItemIdProperty,
        description: {
          type: "string",
          description: "The full new Markdown description",
        },
        descriptionVersion: {
          type: "integer",
          description: "The descriptionVersion from scarn-get-work-item",
        },
      },
      required: ["workItemId", "description", "descriptionVersion"],
    },
    buildDescribeChange,
  );
}

export function createScarnCommentOnWorkItemTool(directory: string): ToolInfo {
  return createChangeTool(
    directory,
    SCARN_COMMENT_ON_WORK_ITEM_TOOL,
    "Add a comment to a work item.",
    {
      type: "object",
      properties: {
        workItemId: workItemIdProperty,
        body: { type: "string", description: "Markdown comment body" },
      },
      required: ["workItemId", "body"],
    },
    buildCommentChange,
  );
}

export function createScarnCloseWorkItemTool(directory: string): ToolInfo {
  return createChangeTool(
    directory,
    SCARN_CLOSE_WORK_ITEM_TOOL,
    "Close a work item with a reason and a short resolution.",
    {
      type: "object",
      properties: {
        workItemId: workItemIdProperty,
        reason: {
          type: "string",
          enum: [...WORK_ITEM_CLOSE_REASONS],
          description: "Why the item is closed",
        },
        resolution: {
          type: "string",
          description: "What was done, or why it is not needed",
        },
      },
      required: ["workItemId", "reason", "resolution"],
    },
    buildCloseChange,
  );
}

export function createScarnStartTaskTool(directory: string): ToolInfo {
  return createChangeTool(
    directory,
    SCARN_START_TASK_TOOL,
    "Start a Task on a work item at the given pipeline step. The Task runs once the item is ready (all its blockers closed).",
    {
      type: "object",
      properties: {
        workItemId: workItemIdProperty,
        stepDefinitionKey: {
          type: "string",
          description: "Key of the pipeline step the Task starts at",
        },
      },
      required: ["workItemId", "stepDefinitionKey"],
    },
    buildStartTaskChange,
  );
}
