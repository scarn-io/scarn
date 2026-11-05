import type { Info as ToolInfo } from "@opencode/plugin/promise/tool";
import {
  WORK_ITEM_CLOSE_REASONS,
  type WorkItemChange,
  type WorkItemCloseReason,
} from "@scarn/sdk/contracts/work-item-changes";
import type { Grant, GrantAction } from "./_shared/current-execution";
import {
  findGrant,
  grantedLabels,
  grantScopes,
  scopeNote,
  scopePhrase,
} from "./_shared/work-item-grants";
import {
  DEFERRED_DESCRIPTION_NOTE,
  invalidInputMessage,
  isLabelList,
  isNonEmptyString,
  recordWorkItemChange,
} from "./_shared/work-item-tool-support";

/**
 * The work item tools that only record a change for the server to apply when
 * the run succeeds: block, describe, label, comment and close.
 */

export const SCARN_BLOCK_WORK_ITEM_TOOL = "scarn-block-work-item";
export const SCARN_SET_WORK_ITEM_DESCRIPTION_TOOL =
  "scarn-set-work-item-description";
export const SCARN_LABEL_WORK_ITEM_TOOL = "scarn-label-work-item";
export const SCARN_COMMENT_ON_WORK_ITEM_TOOL = "scarn-comment-on-work-item";
export const SCARN_CLOSE_WORK_ITEM_TOOL = "scarn-close-work-item";

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

export function buildLabelChange(input: ToolInput): WorkItemChange | string {
  const { workItemId, add, remove } = input;
  if (!isNonEmptyString(workItemId)) {
    return WORK_ITEM_ID_MESSAGE;
  }
  if (add !== undefined && !isLabelList(add)) {
    return invalidInputMessage("`add` must be an array of non-empty strings.");
  }
  if (remove !== undefined && !isLabelList(remove)) {
    return invalidInputMessage(
      "`remove` must be an array of non-empty strings.",
    );
  }
  if ((add?.length ?? 0) === 0 && (remove?.length ?? 0) === 0) {
    return invalidInputMessage("Pass at least one label in `add` or `remove`.");
  }
  return {
    kind: "label",
    workItemId,
    ...(add?.length ? { add } : {}),
    ...(remove?.length ? { remove } : {}),
  };
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

function createChangeTool(
  directory: string,
  name: string,
  action: GrantAction,
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
      content: await recordWorkItemChange(directory, action, () =>
        buildChange(toolInput as ToolInput),
      ),
    }),
  };
}

function blockScopePhrase(grants: readonly Grant[]): string {
  const scopes = grantScopes(grants, "block");
  if (scopes.length === 2) {
    return "your own work item or one of its children";
  }
  return scopes[0] === "self"
    ? "your own work item"
    : "one of your work item's children";
}

const workItemIdProperty = {
  type: "string",
  description: "Id of the work item",
};

export function createScarnBlockWorkItemTool(
  directory: string,
  grants: readonly Grant[],
): ToolInfo {
  return createChangeTool(
    directory,
    SCARN_BLOCK_WORK_ITEM_TOOL,
    "block",
    `Add a block between two work items (the blocking item must be closed before the blocked one is ready), or remove one with \`remove: true\`. The blocked item may be ${blockScopePhrase(grants)}; the blocking item must be in the same scope or created in this run.`,
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
  grants: readonly Grant[],
): ToolInfo {
  return createChangeTool(
    directory,
    SCARN_SET_WORK_ITEM_DESCRIPTION_TOOL,
    "update",
    `Replace a work item's description. Pass the \`descriptionVersion\` you read with scarn-get-work-item; the write is rejected if the description changed since. ${scopeNote(grants, "update")}`,
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

function labelGrantNote(grants: readonly Grant[]): string {
  return (["self", "children"] as const)
    .flatMap((scope) => {
      const grant = findGrant(grants, "label", scope);
      return grant
        ? [
            `On ${scopePhrase([scope])} you may add or remove: ${grant.labels.join(", ")}.`,
          ]
        : [];
    })
    .join(" ");
}

export function createScarnLabelWorkItemTool(
  directory: string,
  grants: readonly Grant[],
): ToolInfo {
  const labelItems = { type: "string", enum: grantedLabels(grants, "label") };
  return createChangeTool(
    directory,
    SCARN_LABEL_WORK_ITEM_TOOL,
    "label",
    `Add labels to a work item, or remove labels from it. Labels are case-sensitive; adding one it already has, or removing one it lacks, does nothing. ${scopeNote(grants, "label")} ${labelGrantNote(grants)}`,
    {
      type: "object",
      properties: {
        workItemId: workItemIdProperty,
        add: {
          type: "array",
          items: labelItems,
          description: "Labels to add",
        },
        remove: {
          type: "array",
          items: labelItems,
          description: "Labels to remove",
        },
      },
      required: ["workItemId"],
    },
    buildLabelChange,
  );
}

export function createScarnCommentOnWorkItemTool(
  directory: string,
  grants: readonly Grant[],
): ToolInfo {
  return createChangeTool(
    directory,
    SCARN_COMMENT_ON_WORK_ITEM_TOOL,
    "comment",
    `Add a comment to a work item. ${scopeNote(grants, "comment")}`,
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

export function createScarnCloseWorkItemTool(
  directory: string,
  grants: readonly Grant[],
): ToolInfo {
  return createChangeTool(
    directory,
    SCARN_CLOSE_WORK_ITEM_TOOL,
    "close",
    `Close a work item with a reason and a short resolution. ${scopeNote(grants, "close")}`,
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
