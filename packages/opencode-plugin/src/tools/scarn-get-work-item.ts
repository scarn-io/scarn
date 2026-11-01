import type { Info as ToolInfo } from "@opencode/plugin/promise/tool";
import {
  invalidInputMessage,
  isNonEmptyString,
  loadWorkItemToolContext,
} from "./_shared/work-item-tool-support";

export const SCARN_GET_WORK_ITEM_TOOL = "scarn-get-work-item";

export const NO_API_MESSAGE =
  "Work items can't be read live in this run: the worker gave no API access.";

/**
 * Reads a work item live from the API with the run's claim token. Records
 * nothing.
 */
export async function getWorkItem(
  input: { workItemId?: unknown },
  directory: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const context = await loadWorkItemToolContext(directory, "self");
  if (typeof context === "string") {
    return context;
  }
  const { api, taskRunId } = context.info;
  if (api === null) {
    return NO_API_MESSAGE;
  }
  if (!isNonEmptyString(input.workItemId)) {
    return invalidInputMessage("`workItemId` must be a non-empty string.");
  }

  const url = `${api.baseUrl.replace(/\/+$/, "")}/api/task-runs/${encodeURIComponent(taskRunId)}/work-item-reads`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        claimToken: api.claimToken,
        workItemId: input.workItemId,
      }),
    });
  } catch (error) {
    return `Reading the work item failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  const text = await response.text();
  if (!response.ok) {
    return `Reading the work item failed (HTTP ${String(response.status)}): ${text}`;
  }
  return text;
}

/** The `scarn-get-work-item` tool, bound to the plugin's directory. */
export function createScarnGetWorkItemTool(directory: string): ToolInfo {
  return {
    name: SCARN_GET_WORK_ITEM_TOOL,
    description:
      "Read a work item live: title, description with its descriptionVersion, fields, state, blockers and children. Works on this Task's own item and, with permission, its children. Changes nothing. Items created earlier in this run don't exist until the run succeeds.",
    input: {
      type: "object",
      properties: {
        workItemId: { type: "string", description: "Id of the work item" },
      },
      required: ["workItemId"],
    },
    options: { codemode: false },
    execute: async (input) => ({
      content: await getWorkItem(input as { workItemId?: unknown }, directory),
    }),
  };
}
