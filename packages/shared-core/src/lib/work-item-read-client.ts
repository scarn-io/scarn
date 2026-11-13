import type { ApiResult, AuthHeaders } from "./api-result";
import type {
  ProjectTaskPage,
  WorkItemActivityEntry,
  WorkItemBlocks,
  WorkItemChild,
  WorkItemComment,
  WorkItemCommentDraft,
  WorkItemDetail,
  WorkItemRunPage,
  WorkItemListPage,
  WorkItemQuestion,
} from "./work-item-api-types";

/**
 * The slice of the generated `ScarnClient` the `work-items` read commands
 * call. A real client matches it at
 * runtime but not structurally (the generated nullable fields are
 * `unknown`), so the CLI casts once with `as unknown as WorkItemReadClient`.
 */
export type WorkItemReadClient = {
  projects: {
    listProjectWorkItems: (options: {
      path: { projectId: string };
      query: {
        q?: string;
        page?: number;
        pageSize?: number;
        updatedAfter?: string;
        assignee?: string;
        status?: string;
        platform?: string;
        labels?: string[];
        sort?: string;
      };
      headers: AuthHeaders;
    }) => Promise<ApiResult<WorkItemListPage>>;
  };
  tasks: {
    listProjectTasks: (options: {
      path: { projectId: string };
      query: { workItemId: string; limit: number };
      headers: AuthHeaders;
    }) => Promise<ApiResult<ProjectTaskPage>>;
  };
  workItems: {
    getWorkItem: (options: {
      path: { workItemId: string };
      headers: AuthHeaders;
    }) => Promise<ApiResult<WorkItemDetail>>;
    listWorkItemChildren: (options: {
      path: { workItemId: string };
      headers: AuthHeaders;
    }) => Promise<ApiResult<WorkItemChild[]>>;
    listWorkItemQuestions: (options: {
      path: { workItemId: string };
      headers: AuthHeaders;
    }) => Promise<ApiResult<WorkItemQuestion[]>>;
    listWorkItemActivity: (options: {
      path: { workItemId: string };
      headers: AuthHeaders;
    }) => Promise<ApiResult<WorkItemActivityEntry[]>>;
  };
  workItemBlocks: {
    listWorkItemBlocks: (options: {
      query: { workItemId: string };
      headers: AuthHeaders;
    }) => Promise<ApiResult<WorkItemBlocks>>;
  };
  workItemComments: {
    listWorkItemComments: (options: {
      query: { workItemId: string };
      headers: AuthHeaders;
    }) => Promise<ApiResult<WorkItemComment[]>>;
  };
  workItemCommentDrafts: {
    listPendingCommentDrafts: (options: {
      query: { workItemId: string };
      headers: AuthHeaders;
    }) => Promise<ApiResult<WorkItemCommentDraft[]>>;
  };
  pipelineExecutions: {
    listPipelineExecutions: (options: {
      query: {
        projectId: string;
        workItemId: string;
        sort: "newest";
        pageSize: number;
      };
      headers: AuthHeaders;
    }) => Promise<ApiResult<WorkItemRunPage>>;
  };
};
