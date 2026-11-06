import type { Info as ToolInfo } from "@opencode/plugin/promise/tool";
import type { Grant } from "./_shared/current-execution";
import { grantedLabels } from "./_shared/work-item-grants";
import {
  invalidInputMessage,
  isLabelList,
  isNonEmptyString,
  loadWorkItemToolContext,
  workItemUrl,
} from "./_shared/work-item-tool-support";

export const SCARN_CREATE_WORK_ITEM_TOOL = "scarn-create-work-item";

export const NO_API_MESSAGE =
  "Work items can't be created in this run: the worker gave no API access.";

export const CREATED_WORK_ITEM_NOTE =
  "Created. Use this workItemId in later calls; link it as `[title](url)`.";

const MAX_WORK_ITEMS_CREATED_PER_TASK = 10;

export type CreateWorkItemInput = {
  title?: unknown;
  description?: unknown;
  fields?: unknown;
  labels?: unknown;
  blockedBy?: unknown;
};

type Attempt = { response: Response } | { error: unknown };

/**
 * Creates a child of the Task's work item through the API, committed at once.
 * The id is generated here so a retry after a lost response reuses it and the
 * server can answer it as a replay instead of creating a second item.
 */
export async function createWorkItem(
  input: CreateWorkItemInput,
  directory: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const context = await loadWorkItemToolContext(directory, "create");
  if (typeof context === "string") {
    return context;
  }
  const { api, taskRunId } = context.info;
  if (api === null) {
    return NO_API_MESSAGE;
  }
  const { title, description, fields, labels, blockedBy } = input;
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
  if (labels !== undefined && !isLabelList(labels)) {
    return invalidInputMessage(
      "`labels` must be an array of non-empty strings.",
    );
  }
  if (
    blockedBy !== undefined &&
    (!Array.isArray(blockedBy) || !blockedBy.every(isNonEmptyString))
  ) {
    return invalidInputMessage(
      "`blockedBy` must be an array of work item ids.",
    );
  }

  const workItemId = Bun.randomUUIDv7();
  const url = `${api.baseUrl.replace(/\/+$/, "")}/api/task-runs/${encodeURIComponent(taskRunId)}/work-item-creates`;
  const body = JSON.stringify({
    claimToken: api.claimToken,
    workItemId,
    title,
    description,
    ...(fields === undefined ? {} : { fields }),
    ...(labels === undefined || labels.length === 0 ? {} : { labels }),
    ...(blockedBy === undefined ? {} : { blockedBy }),
  });
  const post = async (): Promise<Attempt> => {
    try {
      return {
        response: await fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        }),
      };
    } catch (error) {
      return { error };
    }
  };

  let attempt = await post();
  if ("error" in attempt || attempt.response.status >= 500) {
    attempt = await post();
  }
  if ("error" in attempt) {
    const { error } = attempt;
    return `Creating the work item failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  const { response } = attempt;
  const text = await response.text();
  if (!response.ok) {
    return refusalMessage(response.status, text);
  }
  return JSON.stringify({
    workItemId,
    url: workItemUrl(context.info.workItemLinks, workItemId),
    note: CREATED_WORK_ITEM_NOTE,
  });
}

/**
 * The server's own message for a refused create, which is written for the
 * agent, or the status and raw body when the response carries none.
 */
function refusalMessage(status: number, text: string): string {
  let detail: unknown;
  try {
    detail = (JSON.parse(text) as { detail?: unknown } | null)?.detail;
  } catch {
    detail = undefined;
  }
  return isNonEmptyString(detail)
    ? detail
    : `Creating the work item failed (HTTP ${String(status)}): ${text}`;
}

/**
 * The `scarn-create-work-item` tool, bound to the plugin's directory, with
 * `labels` limited to those the run's `create` grant allows.
 */
export function createScarnCreateWorkItemTool(
  directory: string,
  grants: readonly Grant[],
): ToolInfo {
  const labels = grantedLabels(grants, "create");
  return {
    name: SCARN_CREATE_WORK_ITEM_TOOL,
    description: `Create a work item as a child of this Task's work item (it is one of your work item's children). The item exists as soon as this tool returns, and it stays even if this run fails later. Returns the new item's workItemId and url (its web page; link it in descriptions as [title](url)). The workItemId can be used right away in other work item tools (e.g. as a blocker). \`blockedBy\` must name work items that already exist. Labels you may give it: ${labels.join(", ")}. At most ${String(MAX_WORK_ITEMS_CREATED_PER_TASK)} per Task.`,
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
        labels: {
          type: "array",
          items: { type: "string", enum: labels },
          description: "Labels for the new item (case-sensitive)",
        },
        blockedBy: {
          type: "array",
          items: { type: "string" },
          description: "Ids of existing work items that block the new item",
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
