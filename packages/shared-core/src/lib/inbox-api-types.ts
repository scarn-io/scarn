/**
 * Minimal, nullable-correct mirrors of the inbox response bodies `scarn
 * inbox` reads (see `./api-types.ts` for why this package does not import
 * the generated types). Only the fields the formatter uses are typed.
 */

/** `GET /projects/{id}/inbox/summary`. */
export type InboxSummary = {
  waitingOnMe: number;
  failedStartedByMe: number;
  pipelineWaitsOnMe: number;
  workItemsWaitingOnMe: number;
  badgeCount: number;
  waitingOnOthers: number;
};

export type InboxWorkItemRef = {
  id: string;
  platformKey: string;
  title: string;
};

type InboxWaitBase = {
  pipelineExecutionId: string;
  visitId: string;
  nodeId: string;
  pipelineName: string;
  workItem: InboxWorkItemRef;
  askedAt: string;
};

/** An open question a step asked on the work item. */
export type InboxReplyWait = InboxWaitBase & {
  kind: "reply";
  questionId: string;
  commentId: string;
  body: string;
};

/** A `decision` wait node waiting for one of its actions. */
export type InboxDecisionWait = InboxWaitBase & {
  kind: "decision";
  title: string | null;
  actions: { key: string; label: string; body: "optional" | "required" }[];
};

export type InboxWait = InboxReplyWait | InboxDecisionWait;

/** A ready work item that has never had a Task. */
export type InboxReadyWorkItem = InboxWorkItemRef & {
  waitingSince: string;
};

/** `GET /projects/{id}/inbox/waits`. */
export type InboxWaits = {
  waits: InboxWait[];
  workItems: InboxReadyWorkItem[];
};

/** A work item with agent comment drafts waiting for approval. */
export type InboxDraftWorkItem = InboxWorkItemRef & {
  awaitingApprovalCount: number;
};

/** `GET /projects/{id}/work-items?awaitingApproval=true`, the fields used. */
export type InboxDraftWorkItemPage = {
  items: InboxDraftWorkItem[];
  pagination: { total: number };
};

/** One of `GET /projects/{id}/notifications`. */
export type InboxNotification = {
  id: string;
  workItemId: string | null;
  pipelineExecutionId: string | null;
  taskId: string | null;
  kind: string;
  title: string;
  priority: string;
  status: string;
  createdAt: string;
};
