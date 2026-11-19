import type { ApiResult } from "./api-result";
import type {
  InboxDraftWorkItemPage,
  InboxNotification,
  InboxSummary,
  InboxWaits,
} from "./inbox-api-types";
import type { TaskSummaryPage } from "./task-api-types";
import type { ProjectTaskStatus } from "./work-item-api-types";

/**
 * The slice of the generated `ScarnClient` that `scarn inbox` calls. A real
 * client matches it at runtime but not structurally (the generated nullable
 * fields are `unknown`; see `./api-result.ts`), so the CLI casts once with
 * `as unknown as InboxReadClient`.
 */
export type InboxReadClient = {
  inbox: {
    getProjectInboxSummary: (options: {
      path: { projectId: string };
    }) => Promise<ApiResult<InboxSummary>>;
    listProjectInboxWaits: (options: {
      path: { projectId: string };
    }) => Promise<ApiResult<InboxWaits>>;
  };
  tasks: {
    listProjectTasks: (options: {
      path: { projectId: string };
      query: {
        status?: ProjectTaskStatus[];
        waitingOnMe?: boolean;
        startedByMe?: boolean;
        excludeEndedChats?: boolean;
        limit?: number;
      };
    }) => Promise<ApiResult<TaskSummaryPage>>;
  };
  projects: {
    listProjectWorkItems: (options: {
      path: { projectId: string };
      query: { awaitingApproval: "true"; pageSize: number };
    }) => Promise<ApiResult<InboxDraftWorkItemPage>>;
  };
  userNotifications: {
    listUserNotifications: (options: {
      path: { projectId: string };
      query: { status?: string };
    }) => Promise<ApiResult<InboxNotification[]>>;
  };
};
