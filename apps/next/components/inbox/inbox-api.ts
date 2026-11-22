/**
 * Browser fetchers for the project inbox: the badge summary, the open
 * pipeline waits and the work items waiting on the viewer, and the viewer's
 * waiting and failed Tasks.
 * `notifyInboxChanged` tells every inbox reader (the tab badge included) to
 * re-read after an action.
 */
import type {
  ProjectInboxSummaryContract,
  ProjectInboxWaitContract,
  ProjectInboxWaitsContract,
  ProjectInboxWorkItemContract,
} from "@scarn/core/pipeline-executions/pipeline-run/contracts/project-inbox-contracts";
import { MAX_PROJECT_TASKS_LIMIT } from "@scarn/core/tasks/task/contracts/task-summary-contracts";
import { parseUuidV7 } from "@scarn/api/frontend-contracts";
import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import { unwrapTreatyResponse } from "@/app/_lib/scarn-treaty";
import type { TaskSummary } from "@/components/tasks/task-api";

export type InboxSummary = ProjectInboxSummaryContract;
export type InboxWait = ProjectInboxWaitContract;
export type InboxWorkItem = ProjectInboxWorkItemContract;

export const INBOX_POLL_MS = 30_000;
export const INBOX_CHANGED_EVENT = "scarn:inbox-changed";

export function notifyInboxChanged() {
  window.dispatchEvent(new Event(INBOX_CHANGED_EVENT));
}

const inboxRoute = (projectId: string) =>
  getBrowserScarnApiClient().api.projects({
    projectId: parseUuidV7(projectId),
  });

export async function fetchInboxSummary(
  projectId: string,
): Promise<InboxSummary> {
  return await unwrapTreatyResponse(inboxRoute(projectId).inbox.summary.get());
}

/** The pipeline waits, and the ready work items never given a Task, on the viewer. */
export async function fetchInboxWaits(
  projectId: string,
): Promise<ProjectInboxWaitsContract> {
  return await unwrapTreatyResponse(inboxRoute(projectId).inbox.waits.get());
}

/** Agent Tasks whose conversation waits on the viewer. */
export async function fetchTasksWaitingOnMe(
  projectId: string,
): Promise<TaskSummary[]> {
  const page = await unwrapTreatyResponse(
    inboxRoute(projectId).tasks.get({
      query: {
        waitingOnMe: true,
        excludeEndedChats: true,
        limit: MAX_PROJECT_TASKS_LIMIT,
      },
    }),
  );
  return page.tasks;
}

/** Failed Tasks the viewer started, but not those of chats that have ended. */
export async function fetchMyFailedTasks(
  projectId: string,
): Promise<TaskSummary[]> {
  const page = await unwrapTreatyResponse(
    inboxRoute(projectId).tasks.get({
      query: {
        status: "failed",
        startedByMe: true,
        excludeEndedChats: true,
        limit: MAX_PROJECT_TASKS_LIMIT,
      },
    }),
  );
  return page.tasks;
}
