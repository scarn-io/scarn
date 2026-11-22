import { uuidV7Schema } from "@scarn/core/common/contracts/uuid-v7";
import { z } from "zod";
import { decisionActionContractSchema } from "./pipeline-run-contracts";

/** The most waits `GET /projects/:projectId/inbox/waits` returns. */
export const MAX_PROJECT_INBOX_WAITS = 200;
/** The most work items `GET /projects/:projectId/inbox/waits` returns. */
export const MAX_PROJECT_INBOX_WORK_ITEMS = 200;

const inboxPersonSchema = z.object({
  userId: uuidV7Schema,
  /** `null` when unresolved. */
  username: z.string().nullable(),
});

const projectInboxWaitBaseSchema = z.object({
  pipelineExecutionId: uuidV7Schema,
  visitId: uuidV7Schema,
  nodeId: z.string(),
  /** The pipeline the execution runs. */
  pipelineName: z.string(),
  workItem: z.object({
    id: uuidV7Schema,
    platformKey: z.string(),
    title: z.string(),
  }),
  /** When the question was asked, or the decision wait was entered. */
  askedAt: z.iso.datetime(),
  /** The people the wait waits on: the work item's creator and the run's starter. */
  waitingOn: z.array(inboxPersonSchema),
});

/**
 * An open pipeline wait on the viewer. A `reply` wait is answered with
 * `POST /pipeline-executions/:id/questions/:questionId/answer`; a `decision`
 * wait with `POST /pipeline-executions/:id/visits/:visitId/decision`.
 */
export const projectInboxWaitSchema = z.discriminatedUnion("kind", [
  projectInboxWaitBaseSchema.extend({
    kind: z.literal("reply"),
    questionId: uuidV7Schema,
    commentId: uuidV7Schema,
    /** The question comment's text. */
    body: z.string(),
  }),
  projectInboxWaitBaseSchema.extend({
    kind: z.literal("decision"),
    /** The wait node's title, if it has one. */
    title: z.string().nullable(),
    /** The actions the node offers, in button order. */
    actions: z.array(decisionActionContractSchema),
  }),
]);

/**
 * An open, ready work item that has never had a Task and waits on the
 * viewer: they are its assignee or creator or, when it has neither, its
 * nearest parent's that has either.
 */
export const projectInboxWorkItemSchema = z.object({
  id: uuidV7Schema,
  platformKey: z.string(),
  title: z.string(),
  labels: z.array(z.string()),
  /** Its parent work item, if it has one. */
  parent: z.object({ id: uuidV7Schema, title: z.string() }).nullable(),
  /** When it last became ready: its creation, or its newest blocker's close. */
  waitingSince: z.iso.datetime(),
  /** Everyone it waits on. */
  waitingOn: z.array(inboxPersonSchema),
});

/**
 * The project's open pipeline waits on the viewer, newest first, and the
 * work items waiting on them, most recently ready first.
 */
export const projectInboxWaitsSchema = z.object({
  waits: z.array(projectInboxWaitSchema),
  workItems: z.array(projectInboxWorkItemSchema),
});

/** The counts behind the inbox badge. */
export const projectInboxSummarySchema = z.object({
  /** Agent Tasks whose conversation waits on the viewer. */
  waitingOnMe: z.number().int().nonnegative(),
  /** Failed Tasks the viewer started, but not those of ended chats. */
  failedStartedByMe: z.number().int().nonnegative(),
  /** Open pipeline questions and decision waits on the viewer. */
  pipelineWaitsOnMe: z.number().int().nonnegative(),
  /** Ready work items never given a Task that wait on the viewer. */
  workItemsWaitingOnMe: z.number().int().nonnegative(),
  /** `waitingOnMe + pipelineWaitsOnMe + failedStartedByMe + workItemsWaitingOnMe`. */
  badgeCount: z.number().int().nonnegative(),
  /** Tasks `waiting_for_person` that don't wait on the viewer. */
  waitingOnOthers: z.number().int().nonnegative(),
});

export type ProjectInboxWaitContract = z.infer<typeof projectInboxWaitSchema>;
export type ProjectInboxWorkItemContract = z.infer<
  typeof projectInboxWorkItemSchema
>;
export type ProjectInboxWaitsContract = z.infer<typeof projectInboxWaitsSchema>;
export type ProjectInboxSummaryContract = z.infer<
  typeof projectInboxSummarySchema
>;
