import type { Info as ToolInfo } from "@opencode/plugin/promise/tool";
import {
  hasGrantFor,
  loadCurrentExecutionInfo,
  type CurrentExecutionInfo,
  type Grant,
} from "./_shared/current-execution";
import { findGrant, grantedLabels } from "./_shared/work-item-grants";
import { resolveWorktree } from "./_shared/resolve-worktree";
import {
  invalidInputMessage,
  isLabelList,
  isNonEmptyString,
  missingGrantMessage,
  NO_WORK_ITEM_MESSAGE,
  workItemUrl,
} from "./_shared/work-item-tool-support";

export const SCARN_CREATE_WORK_ITEM_TOOL = "scarn-create-work-item";

export const NO_API_MESSAGE =
  "Work items can't be created in this run: the worker gave no API access.";

export const CREATED_WORK_ITEM_NOTE =
  "Created. Use this workItemId in later calls; link it as `[title](url)`.";

export const EXISTING_WORK_ITEM_NOTE =
  "Already in the project under this platformKey; nothing was changed. Use this workItemId in later calls.";

export const NO_PROJECT_CREATE_MESSAGE =
  "This Task may not create top-level work items: it has no `create` grant on `project`, so leave out `platformKey`.";

export const PLATFORM_KEY_REQUIRED_MESSAGE =
  "This Task creates top-level work items in the project: give each a `platformKey`, a stable id from the system it comes from.";

const MAX_WORK_ITEMS_CREATED_PER_TASK = 10;
const MAX_PROJECT_WORK_ITEMS_CREATED_PER_TASK = 100;

export type CreateWorkItemInput = {
  title?: unknown;
  description?: unknown;
  fields?: unknown;
  labels?: unknown;
  blockedBy?: unknown;
  platformKey?: unknown;
  url?: unknown;
};

type Attempt = { response: Response } | { error: unknown };

type CreateScope = "children" | "project";

/**
 * Which scope the create is for, or a refusal: `project` when it names a
 * `platformKey`, `children` otherwise. A run with no work item can only
 * create in the project.
 */
function scopeOf(
  info: CurrentExecutionInfo,
  platformKey: string | undefined,
): { scope: CreateScope } | { refusal: string } {
  const canCreateInProject =
    findGrant(info.grants, "create", "project") !== undefined;
  const canCreateChildren =
    info.workItemId !== null &&
    findGrant(info.grants, "create", "children") !== undefined;
  if (platformKey !== undefined) {
    return canCreateInProject
      ? { scope: "project" }
      : { refusal: NO_PROJECT_CREATE_MESSAGE };
  }
  if (canCreateChildren) {
    return { scope: "children" };
  }
  if (canCreateInProject) {
    return { refusal: PLATFORM_KEY_REQUIRED_MESSAGE };
  }
  return {
    refusal:
      info.workItemId === null
        ? NO_WORK_ITEM_MESSAGE
        : missingGrantMessage("create"),
  };
}

/**
 * Creates a work item through the API, committed at once: a child of the
 * Task's work item, or, given a `platformKey`, a top-level item in the
 * project that a repeat create with the same key returns instead of
 * duplicating. The id is generated here so a retry after a lost response
 * reuses it and the server can answer it as a replay.
 */
export async function createWorkItem(
  input: CreateWorkItemInput,
  directory: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const info = await loadCurrentExecutionInfo(await resolveWorktree(directory));
  if (!hasGrantFor(info.grants, "create")) {
    return info.workItemId === null
      ? NO_WORK_ITEM_MESSAGE
      : missingGrantMessage("create");
  }
  const { title, description, fields, labels, blockedBy, url } = input;
  if (input.platformKey !== undefined && !isNonEmptyString(input.platformKey)) {
    return invalidInputMessage("`platformKey` must be a non-empty string.");
  }
  const platformKey = input.platformKey;
  const resolved = scopeOf(info, platformKey);
  if ("refusal" in resolved) {
    return resolved.refusal;
  }
  const { scope } = resolved;
  const { api, taskRunId } = info;
  if (api === null) {
    return NO_API_MESSAGE;
  }
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
  if (scope === "project" && blockedBy !== undefined && blockedBy.length > 0) {
    return invalidInputMessage(
      "`blockedBy` can't be given with `platformKey`.",
    );
  }
  if (url !== undefined && (scope !== "project" || !isNonEmptyString(url))) {
    return invalidInputMessage(
      "`url` must be a non-empty string, given only with `platformKey`.",
    );
  }

  const workItemId = Bun.randomUUIDv7();
  const endpoint = `${api.baseUrl.replace(/\/+$/, "")}/api/task-runs/${encodeURIComponent(taskRunId)}/work-item-creates`;
  const body = JSON.stringify({
    claimToken: api.claimToken,
    workItemId,
    ...(scope === "project" ? { scope, platformKey } : {}),
    ...(url === undefined ? {} : { url }),
    title,
    description,
    ...(fields === undefined ? {} : { fields }),
    ...(labels === undefined || labels.length === 0 ? {} : { labels }),
    ...(blockedBy === undefined || scope === "project" ? {} : { blockedBy }),
  });
  const post = async (): Promise<Attempt> => {
    try {
      return {
        response: await fetchImpl(endpoint, {
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
  const answered = scope === "project" ? parseCreated(text) : null;
  const id = answered?.workItemId ?? workItemId;
  const existing = answered?.created === false;
  return JSON.stringify({
    workItemId: id,
    url: workItemUrl(info.workItemLinks, id),
    note: existing ? EXISTING_WORK_ITEM_NOTE : CREATED_WORK_ITEM_NOTE,
  });
}

function parseCreated(
  text: string,
): { workItemId: string; created: boolean } | null {
  try {
    const parsed = JSON.parse(text) as {
      workItemId?: unknown;
      created?: unknown;
    } | null;
    return isNonEmptyString(parsed?.workItemId) &&
      typeof parsed.created === "boolean"
      ? { workItemId: parsed.workItemId, created: parsed.created }
      : null;
  } catch {
    return null;
  }
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

const CHILDREN_DESCRIPTION = `Without \`platformKey\`, it is a child of this Task's work item. \`blockedBy\` must name work items that already exist. At most ${String(MAX_WORK_ITEMS_CREATED_PER_TASK)} children per Task.`;

const PROJECT_DESCRIPTION = `With \`platformKey\`, it is a top-level work item in the project. \`platformKey\` is a stable id from the system the item comes from, such as an external ticket's id: creating with a key the project already has returns that item, unchanged, instead of a duplicate, so send every item you find without checking first. At most ${String(MAX_PROJECT_WORK_ITEMS_CREATED_PER_TASK)} new items per Task.`;

/**
 * The `scarn-create-work-item` tool, bound to the plugin's directory, with
 * `labels` limited to those the run's `create` grants allow, and the project
 * form (`platformKey`, `url`) or the child form (`blockedBy`) offered by the
 * grant scopes the run has.
 */
export function createScarnCreateWorkItemTool(
  directory: string,
  grants: readonly Grant[],
): ToolInfo {
  const labels = grantedLabels(grants, "create");
  const children = findGrant(grants, "create", "children") !== undefined;
  const project = findGrant(grants, "create", "project") !== undefined;
  return {
    name: SCARN_CREATE_WORK_ITEM_TOOL,
    description: [
      "Create a work item. The item exists as soon as this tool returns, and it stays even if this run fails later. Returns the item's workItemId and url (its web page; link it in descriptions as [title](url)). The workItemId can be used right away in other work item tools.",
      ...(children ? [CHILDREN_DESCRIPTION] : []),
      ...(project ? [PROJECT_DESCRIPTION] : []),
      ...(project && !children ? ["`platformKey` is required."] : []),
      `Labels you may give it: ${labels.join(", ")}.`,
    ].join(" "),
    input: {
      type: "object",
      properties: {
        ...(project
          ? {
              platformKey: {
                type: "string",
                description:
                  "Stable id of the item in the system it comes from; the same key returns the existing item",
              },
              url: {
                type: "string",
                description: "Optional link to the item in that system",
              },
            }
          : {}),
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
        ...(children
          ? {
              blockedBy: {
                type: "array",
                items: { type: "string" },
                description:
                  "Ids of existing work items that block the new item",
              },
            }
          : {}),
      },
      required: [
        ...(project && !children ? ["platformKey"] : []),
        "title",
        "description",
      ],
    },
    options: { codemode: false },
    execute: async (input) => ({
      content: await createWorkItem(input as CreateWorkItemInput, directory),
    }),
  };
}
