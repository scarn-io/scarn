import { describeApiError } from "./lib/api-errors";
import type { ApiResult, AuthHeaders } from "./lib/api-result";
import type {
  InboxDraftWorkItemPage,
  InboxNotification,
  InboxSummary,
  InboxWaits,
} from "./lib/inbox-api-types";
import type { InboxReadClient } from "./lib/inbox-read-client";
import type { TaskSummaryPage } from "./lib/task-api-types";

/**
 * The reads behind `scarn inbox`, fetched in parallel: the badge counts, the
 * pipeline waits on the caller, the Tasks waiting on them, the failed Tasks
 * they started, work items with comment drafts to approve, and the latest
 * notifications. {@link formatInbox} renders it.
 */

/** One sub-read of `inbox`: loaded, or the reason it failed. */
export type InboxSection<T> =
  { status: "loaded"; data: T } | { status: "unavailable"; reason: string };

export type GatheredInbox = {
  summary: InboxSummary;
  waits: InboxSection<InboxWaits>;
  tasksWaitingOnMe: InboxSection<TaskSummaryPage>;
  failedTasks: InboxSection<TaskSummaryPage>;
  drafts: InboxSection<InboxDraftWorkItemPage>;
  notifications: InboxSection<InboxNotification[]>;
};

export type GatherInboxOptions = {
  client: InboxReadClient;
  headers: AuthHeaders;
  projectId: string;
  /** How many entries each list shows. */
  limit: number;
};

async function section<T>(
  request: () => Promise<ApiResult<T>>,
): Promise<InboxSection<T>> {
  try {
    const result = await request();
    return result.error === undefined
      ? { status: "loaded", data: result.data }
      : { status: "unavailable", reason: describeApiError(result.error) };
  } catch (error) {
    return {
      status: "unavailable",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/** The caller's inbox in one project. The summary must load; any other read
 * that fails becomes an `unavailable` section. */
export async function gatherInbox(
  options: GatherInboxOptions,
): Promise<GatheredInbox> {
  const { client, headers, projectId, limit } = options;
  const path = { projectId };

  const [summary, waits, tasksWaitingOnMe, failedTasks, drafts, notifications] =
    await Promise.all([
      client.inbox.getProjectInboxSummary({ path, headers }),
      section(() => client.inbox.listProjectInboxWaits({ path, headers })),
      section(() =>
        client.tasks.listProjectTasks({
          path,
          query: { waitingOnMe: true, excludeEndedChats: true, limit },
          headers,
        }),
      ),
      section(() =>
        client.tasks.listProjectTasks({
          path,
          query: {
            status: ["failed"],
            startedByMe: true,
            excludeEndedChats: true,
            limit,
          },
          headers,
        }),
      ),
      section(() =>
        client.projects.listProjectWorkItems({
          path,
          query: { awaitingApproval: "true", pageSize: limit },
          headers,
        }),
      ),
      section(() =>
        client.userNotifications.listUserNotifications({
          path,
          query: {},
          headers,
        }),
      ),
    ]);

  if (summary.error !== undefined) {
    throw new Error(
      `Could not load the inbox: ${describeApiError(summary.error)}`,
    );
  }

  return {
    summary: summary.data,
    waits,
    tasksWaitingOnMe,
    failedTasks,
    drafts,
    notifications,
  };
}
