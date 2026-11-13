/**
 * Correctly-nullable mirrors of the work-item read responses the CLI's
 * `work-items` commands render. Same rationale as `./api-types.ts`: the
 * generated `@scarn/sdk` types collapse every nullable field to `unknown`.
 * Only the fields the formatters read are declared; `--json` prints the raw
 * body, so nothing is lost by the narrowing.
 */

export type WorkItemPlatform =
  "jira" | "github" | "bitbucket" | "linear" | "scarn" | "custom";

export type WorkItemDetail = {
  id: string;
  projectId: string;
  platform: WorkItemPlatform;
  platformKey: string;
  url?: string | null;
  title: string;
  description: string;
  fields: Record<string, unknown> | null;
  labels: string[];
  createdByUsername: string | null;
  assigneeUserId: string | null;
  parentWorkItemId: string | null;
  state: "open" | "closed";
  closeReason: "completed" | "out_of_scope" | "superseded" | null;
  resolution: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type WorkItemAssignee = {
  userId: string;
  username: string | null;
};

export type WorkItemListItem = WorkItemDetail & {
  latestExecutionStatus: string | null;
  assignee: WorkItemAssignee | null;
};

export type WorkItemListPage = {
  items: WorkItemListItem[];
  pagination: { page: number; pageSize: number; total: number };
};

export type ProjectTaskStatus =
  | "waiting_for_concurrency_slot"
  | "waiting_for_work"
  | "queued"
  | "running"
  | "waiting_for_person"
  | "succeeded"
  | "failed"
  | "cancelled";

export type WorkItemChild = WorkItemDetail & {
  status: "needs_person" | "running" | "ready" | "blocked" | "closed";
  assignee: WorkItemAssignee | null;
};

export type WorkItemBlock = {
  id: string;
  blockedWorkItemId: string;
  blockingWorkItemId: string;
  createdAt: string;
};

export type WorkItemBlocks = {
  blockedBy: WorkItemBlock[];
  blocking: WorkItemBlock[];
};

export type WorkItemQuestion = {
  questionId: string;
  status: "open" | "answered" | "not_needed";
  pipelineExecutionId: string;
  body: string;
  askedAt: string;
  waitingOn: { userId: string; username: string | null }[];
};

export type WorkItemRunListItem = {
  id: string;
  pipelineDefinitionId: string;
  status:
    "queued" | "running" | "waiting" | "succeeded" | "failed" | "cancelled";
  waitingFor: "decision" | "reply" | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
};

export type WorkItemRunPage = {
  items: WorkItemRunListItem[];
  pagination: { page: number; pageSize: number; total: number };
};

export type ProjectTaskListItem = {
  id: string;
  kind: "agent" | "code";
  name: string | null;
  status: ProjectTaskStatus;
  createdAt: string;
  pipelineRun: { name: string; number: number } | null;
  pipelineRunId: string | null;
  latest: { kind: "error" | "message" | "log"; text: string } | null;
};

export type ProjectTaskPage = {
  tasks: ProjectTaskListItem[];
  nextCursor: string | null;
};

export type WorkItemComment = {
  id: string;
  authorKind: "user" | "agent";
  authorName: string | null;
  authorUsername: string | null;
  authoredByTaskId: string | null;
  parentCommentId: string | null;
  externalCommentUrl: string | null;
  body: string;
  isPinned: boolean;
  createdAt: string;
};

export type WorkItemCommentDraft = {
  notification: {
    id: string;
    pipelineExecutionId: string | null;
    taskId: string | null;
    title: string;
    body: string;
    status: string;
    createdAt: string;
  };
  lastError: string | null;
};

export type WorkItemActivityEntry = {
  id: string;
  kind: string;
  message: string;
  createdAt: string;
};
