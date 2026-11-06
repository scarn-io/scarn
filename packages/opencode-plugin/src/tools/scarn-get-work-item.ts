import type { Info as ToolInfo } from "@opencode/plugin/promise/tool";
import {
  invalidInputMessage,
  isNonEmptyString,
  loadWorkItemToolContext,
  workItemUrl,
} from "./_shared/work-item-tool-support";
import type { CurrentExecutionInfo, Grant } from "./_shared/current-execution";
import { checkGrantOn, scopeNote } from "./_shared/work-item-grants";

export const SCARN_GET_WORK_ITEM_TOOL = "scarn-get-work-item";

export const NO_API_MESSAGE =
  "Work items can't be read live in this run: the worker gave no API access.";

/**
 * Reads a work item live from the API with the run's claim token: the given
 * one, or the run's own when `workItemId` is left out. Records nothing.
 */
export async function getWorkItem(
  input: { workItemId?: unknown },
  directory: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const context = await loadWorkItemToolContext(directory, "read");
  if (typeof context === "string") {
    return context;
  }
  const { api, taskRunId } = context.info;
  if (api === null) {
    return NO_API_MESSAGE;
  }
  if (input.workItemId !== undefined && !isNonEmptyString(input.workItemId)) {
    return invalidInputMessage(
      "`workItemId` must be a non-empty string, or left out to read your own work item.",
    );
  }
  const workItemId = input.workItemId ?? context.info.workItemId;
  const refusal = checkGrantOn(
    context.info.grants,
    context.info.workItemId,
    "read",
    workItemId,
  );
  if (refusal !== null) {
    return refusal;
  }

  const url = `${api.baseUrl.replace(/\/+$/, "")}/api/task-runs/${encodeURIComponent(taskRunId)}/work-item-reads`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        claimToken: api.claimToken,
        workItemId,
      }),
    });
  } catch (error) {
    return `Reading the work item failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  const text = await response.text();
  if (!response.ok) {
    return `Reading the work item failed (HTTP ${String(response.status)}): ${text}`;
  }
  return withWorkItemUrls(text, context.info.workItemLinks);
}

type ReadItem = {
  [key: string]: unknown;
  id?: unknown;
  blockers?: unknown;
  children?: unknown;
};

// eslint-disable-next-line local/no-unknown-parameter-type -- a type guard
function isReadItem(value: unknown): value is ReadItem {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Adds each item's web page `url` to the read: the item's own, and every
 * blocker's and child's. The API read carries no URLs; they are built here
 * from the run's links so there is one place that knows their shape.
 */
function withWorkItemUrls(
  text: string,
  links: CurrentExecutionInfo["workItemLinks"],
): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  if (!isReadItem(parsed)) {
    return text;
  }
  const root = parsed;
  const addUrl = (item: ReadItem): ReadItem => ({
    ...item,
    url: typeof item.id === "string" ? workItemUrl(links, item.id) : null,
  });
  const addUrls = (list: unknown[]): unknown[] =>
    list.map((entry) => (isReadItem(entry) ? addUrl(entry) : entry));
  return JSON.stringify({
    ...addUrl(root),
    ...(Array.isArray(root.blockers)
      ? { blockers: addUrls(root.blockers) }
      : {}),
    ...(Array.isArray(root.children)
      ? { children: addUrls(root.children) }
      : {}),
  });
}

/** The `scarn-get-work-item` tool, bound to the plugin's directory. */
export function createScarnGetWorkItemTool(
  directory: string,
  grants: readonly Grant[],
): ToolInfo {
  return {
    name: SCARN_GET_WORK_ITEM_TOOL,
    description: `Read a work item live: url (its web page), title, labels, description with its descriptionVersion, fields, state, blockers and children. Each blocker and child has its url, labels, state, close reason, open blockers (\`blockedBy\`) and newest Task's status (\`latestTaskStatus\`, null if it never had one). ${scopeNote(grants, "read")} Changes nothing.`,
    input: {
      type: "object",
      properties: {
        workItemId: {
          type: "string",
          description:
            "Id of the work item. Leave out to read this Task's own work item. Not the task run id.",
        },
      },
    },
    options: { codemode: false },
    execute: async (input) => ({
      content: await getWorkItem(input as { workItemId?: unknown }, directory),
    }),
  };
}
