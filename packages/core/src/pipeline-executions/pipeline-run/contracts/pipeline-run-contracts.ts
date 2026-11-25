import {
  anyJsonObjectSchema,
  anyJsonValueSchema,
} from "@scarn/core/common/contracts/json";
import { startedBySchema } from "@scarn/core/common/contracts/started-by";
import { uuidV7Schema } from "@scarn/core/common/contracts/uuid-v7";
import { z } from "zod";
import { DECISION_BODY_MODES } from "@scarn/sdk/contracts/pipeline-document";
import { taskRunStatusValues } from "@scarn/core/tasks/task-run/domain/task-run-entity";
import {
  sendStepMessageBodySchema,
  taskMessageSchema,
} from "@scarn/core/tasks/task-message/contracts/task-message-contracts";
import { pipelineRunStatusValues } from "../domain/pipeline-run-entity";

/**
 * What the API shows for a run. `active` is split by reading its open step
 * visits' latest Tasks: `running` when at least one is claimed, else
 * `queued`. Nothing here is stored.
 */
export const pipelineExecutionDisplayStatusValues = [
  "queued",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "cancelled",
] as const;

export const nodeVisitKindValues = ["step", "wait", "succeed", "fail"] as const;

export const nodeVisitStatusValues = [
  "active",
  "waiting",
  "succeeded",
  "failed",
  "cancelled",
  "superseded",
] as const;

export const laneGroupStatusValues = ["open", "merged", "failed"] as const;

export const laneStatusValues = [
  "pending",
  "active",
  "arrived",
  "ended",
  "failed",
  "cancelled",
] as const;

/** What a wait node waits for: a person's decision, or a reply to its question. */
export const waitForValues = ["decision", "reply"] as const;

/** One choice a decision wait offers, in button order. */
export const decisionActionContractSchema = z.object({
  key: z.string(),
  label: z.string(),
  body: z.enum(DECISION_BODY_MODES),
});

export const visitQuestionStatusValues = [
  "open",
  "answered",
  "not_needed",
] as const;

/** A question comment a wait visit asked; `not_needed` once the visit closed unanswered. */
export const visitQuestionSchema = z.object({
  questionId: uuidV7Schema,
  commentId: uuidV7Schema,
  status: z.enum(visitQuestionStatusValues),
});

/**
 * A question comment on a work item, with the run and visit that asked it,
 * the question's text and who it waits on: the work item's creator and the
 * run's starter, the people Scarn notified.
 */
export const workItemQuestionSchema = visitQuestionSchema.extend({
  visitId: uuidV7Schema,
  pipelineExecutionId: uuidV7Schema,
  body: z.string(),
  askedAt: z.iso.datetime(),
  /** True when the question is open and waits on the viewer in particular. */
  waitingOnYou: z.boolean(),
  /** The people an open question waits on; empty once it's resolved. */
  waitingOn: z.array(
    z.object({
      userId: uuidV7Schema,
      /** `null` when unresolved. */
      username: z.string().nullable(),
    }),
  ),
});

export const engineErrorSchema = z.object({
  name: z.string(),
  message: z.string(),
  cause: anyJsonValueSchema.optional(),
});

/** One run of the visit's Task; retries and continuations add runs. `taskId` is the run id. */
export const visitTaskSchema = z.object({
  taskId: uuidV7Schema,
  attemptNumber: z.number().int().positive(),
  /** With the liveness overlay: reports `abandoned` / `timeout` from the Task's own clocks. */
  status: z.enum(taskRunStatusValues),
  startedAt: z.iso.datetime().nullable(),
  completedAt: z.iso.datetime().nullable(),
  workBranch: z.string().nullable(),
});

/**
 * How a visit was entered; `merge`: a merge node entered once its lanes arrived.
 * `kind` is one of `start`, `route`, `otherwise`, `catch` or `merge` today, but
 * stays an open string: run history is read back from stored rows, so a kind a
 * later engine retires must still serialize.
 */
export const visitTransitionSchema = z.object({
  kind: z.string(),
  index: z.number().int().nonnegative(),
});

export const nodeVisitSchema = z.object({
  id: uuidV7Schema,
  nodeId: z.string(),
  nodeKind: z.enum(nodeVisitKindValues),
  laneId: uuidV7Schema.nullable(),
  fromVisitId: uuidV7Schema.nullable(),
  fromLaneGroupId: uuidV7Schema.nullable(),
  transition: visitTransitionSchema,
  routing: anyJsonObjectSchema.nullable(),
  status: z.enum(nodeVisitStatusValues),
  /** Wait visits: what the wait is for. Null for other visits. */
  waitFor: z.enum(waitForValues).nullable(),
  /** Decision waits: the actions the node offers, in order. Null for other visits. */
  actions: z.array(decisionActionContractSchema).nullable(),
  input: anyJsonObjectSchema,
  /**
   * Step visits: the result of run `resultTaskId`, or `{ conversationId, summary }`
   * for a conversation a person ended. Decision waits: `{ action, body }`;
   * reply waits: `{ replied, body, commentId }`.
   */
  result: anyJsonValueSchema.nullable(),
  resultTaskId: uuidV7Schema.nullable(),
  error: engineErrorSchema.nullable(),
  tasks: z.array(visitTaskSchema),
  /** The question comments the visit asked, oldest first. */
  questions: z.array(visitQuestionSchema),
  /** Step visits: the conversation, once the agent first handed it to a person. */
  conversationId: uuidV7Schema.nullable(),
  createdByUserId: uuidV7Schema.nullable(),
  resolvedByUserId: uuidV7Schema.nullable(),
  resolvedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
});

export const laneGroupSchema = z.object({
  id: uuidV7Schema,
  parentLaneId: uuidV7Schema.nullable(),
  spawnedByVisitId: uuidV7Schema,
  /** `each`: one lane per item; `all`: one lane per route a `match: "all"` node took. */
  kind: z.enum(["each", "all"]),
  /** How many lanes the split spawned. */
  laneCount: z.number().int().nonnegative(),
  maxConcurrency: z.number().int().positive().nullable(),
  toleratedFailures: z.union([
    z.object({ count: z.number().int().nonnegative() }),
    z.object({ percent: z.number().nonnegative() }),
  ]),
  status: z.enum(laneGroupStatusValues),
});

export const laneSchema = z.object({
  id: uuidV7Schema,
  laneGroupId: uuidV7Schema,
  index: z.number().int().nonnegative(),
  item: anyJsonValueSchema.nullable(),
  /** The route that started the lane; `merge` for a continuation lane. */
  route: visitTransitionSchema,
  /** `split`: spawned by the split; `merge`: the continuation of a partial merge. */
  origin: z.enum(["split", "merge"]),
  status: z.enum(laneStatusValues),
  /** The merge node the lane arrived at with a `partial` route. */
  arrivedAtNodeId: z.string().nullable(),
  /** The args the lane supplied to the merge. */
  arrivalArgs: anyJsonObjectSchema.nullable(),
  /** The visit whose `partial` route arrived; null when a nested merge carried the lane there. */
  arrivedFromVisitId: uuidV7Schema.nullable(),
  arrivalTransition: visitTransitionSchema.nullable(),
  /** The merge visit the arrival went into, once the merge fired. */
  mergedIntoVisitId: uuidV7Schema.nullable(),
});

const pipelineExecutionBaseSchema = z.object({
  id: uuidV7Schema,
  projectId: uuidV7Schema,
  workItemId: uuidV7Schema,
  workItemTitle: z.string(),
  pipelineDefinitionId: uuidV7Schema,
  pipelineDefinitionVersionId: uuidV7Schema,
  /** The stored status the engine decided. */
  runStatus: z.enum(pipelineRunStatusValues),
  status: z.enum(pipelineExecutionDisplayStatusValues),
  /**
   * What a `waiting` run waits on: `reply` when a step waits in its
   * conversation or a wait wants a reply. Null unless waiting.
   */
  waitingFor: z.enum(waitForValues).nullable(),
  endNodeId: z.string().nullable(),
  error: engineErrorSchema.nullable(),
  triggeredByUserId: uuidV7Schema.nullable(),
  startedBy: startedBySchema,
  cancelledByUserId: uuidV7Schema.nullable(),
  startedAt: z.iso.datetime().nullable(),
  completedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

/** A run with its whole history: visits, lane groups and lanes. */
export const pipelineExecutionSchema = pipelineExecutionBaseSchema.extend({
  visits: z.array(nodeVisitSchema),
  laneGroups: z.array(laneGroupSchema),
  lanes: z.array(laneSchema),
});

/** The list projection: the run plus the nodes it is currently at. */
export const pipelineExecutionSummarySchema =
  pipelineExecutionBaseSchema.extend({
    openNodeIds: z.array(z.string()),
  });

export const DEFAULT_PIPELINE_EXECUTIONS_PAGE_SIZE = 25;
export const MAX_PIPELINE_EXECUTIONS_PAGE_SIZE = 100;

export const pipelineExecutionSortValues = ["newest", "oldest"] as const;

export const listPipelineExecutionsQuerySchema = z.object({
  projectId: uuidV7Schema,
  pipelineId: uuidV7Schema.optional(),
  workItemId: uuidV7Schema.optional(),
  status: z.enum(pipelineExecutionDisplayStatusValues).optional(),
  sort: z.enum(pipelineExecutionSortValues).default("newest"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PIPELINE_EXECUTIONS_PAGE_SIZE)
    .default(DEFAULT_PIPELINE_EXECUTIONS_PAGE_SIZE),
});

export const paginatedPipelineExecutionSummariesSchema = z.object({
  items: z.array(pipelineExecutionSummarySchema),
  pagination: z.object({
    page: z.number().int(),
    pageSize: z.number().int(),
    total: z.number().int(),
  }),
});

/** Starts a run on the pipeline's active version, or on `version` when given. */
export const createPipelineExecutionInputSchema = z.object({
  projectId: uuidV7Schema,
  workItemId: uuidV7Schema,
  pipelineDefinitionId: uuidV7Schema,
  version: z.number().int().positive().optional(),
});

export const getPipelineExecutionInputSchema = uuidV7Schema;

export const cancelPipelineExecutionsInputSchema = z
  .array(getPipelineExecutionInputSchema)
  .min(1);
export const cancelPipelineExecutionsResultSchema = z.object({
  cancelledIds: z.array(uuidV7Schema),
  skippedIds: z.array(uuidV7Schema),
});

const visitRefSchema = z.object({
  pipelineExecutionId: uuidV7Schema,
  visitId: uuidV7Schema,
});

export const rerunVisitInputSchema = visitRefSchema;

export const sendVisitMessageInputSchema = sendStepMessageBodySchema.extend(
  visitRefSchema.shape,
);

export const sendVisitMessageResultSchema = z.object({
  message: taskMessageSchema,
  pipelineExecution: pipelineExecutionSchema,
});

export const decideWaitVisitInputSchema = visitRefSchema.extend({
  action: z.string().min(1),
  body: z.string().max(10_000).nullable().optional(),
});

export const continueWithoutReplyInputSchema = z.object({
  pipelineExecutionId: uuidV7Schema,
  questionId: uuidV7Schema,
});

export const answerQuestionBodySchema = z.object({
  body: z.string().trim().min(1).max(10_000),
});

export const answerQuestionInputSchema = continueWithoutReplyInputSchema.extend(
  answerQuestionBodySchema.shape,
);

export const listWorkItemQuestionsInputSchema = uuidV7Schema;

export const getVisitThreadInputSchema = visitRefSchema;

/** One Task in a visit's thread, with the messages that started it. */
export const visitThreadRunSchema = z.object({
  taskRunId: uuidV7Schema,
  previousTaskRunId: uuidV7Schema.nullable(),
  status: z.enum(taskRunStatusValues),
  createdAt: z.iso.datetime(),
  messages: z.array(taskMessageSchema),
  /** Whether this run restored the previous run's agent session; null when
   * there was nothing to restore. */
  sessionRestored: z.boolean().nullable(),
});

/** A step visit's conversation: its latest Task's previous-run chain, oldest first. */
export const visitThreadSchema = z.object({
  visitId: uuidV7Schema,
  nodeId: z.string(),
  runs: z.array(visitThreadRunSchema),
});

export type PipelineExecutionDisplayStatus =
  (typeof pipelineExecutionDisplayStatusValues)[number];
export type VisitTaskContract = z.infer<typeof visitTaskSchema>;
export type NodeVisitContract = z.infer<typeof nodeVisitSchema>;
export type LaneGroupContract = z.infer<typeof laneGroupSchema>;
export type LaneContract = z.infer<typeof laneSchema>;
export type PipelineExecutionContract = z.infer<typeof pipelineExecutionSchema>;
export type PipelineExecutionSummaryContract = z.infer<
  typeof pipelineExecutionSummarySchema
>;
export type PipelineExecutionSort =
  (typeof pipelineExecutionSortValues)[number];
export type ListPipelineExecutionsQuery = z.infer<
  typeof listPipelineExecutionsQuerySchema
>;
export type ListPipelineExecutionsQueryInput = z.input<
  typeof listPipelineExecutionsQuerySchema
>;
export type PaginatedPipelineExecutionSummariesContract = z.infer<
  typeof paginatedPipelineExecutionSummariesSchema
>;
export type CreatePipelineExecutionInput = z.input<
  typeof createPipelineExecutionInputSchema
>;
export type GetPipelineExecutionInput = z.input<
  typeof getPipelineExecutionInputSchema
>;
export type CancelPipelineExecutionsInput = z.input<
  typeof cancelPipelineExecutionsInputSchema
>;
export type CancelPipelineExecutionsResult = z.infer<
  typeof cancelPipelineExecutionsResultSchema
>;
export type RerunVisitInput = z.input<typeof rerunVisitInputSchema>;
export type SendVisitMessageInput = z.input<typeof sendVisitMessageInputSchema>;
export type SendVisitMessageResult = z.infer<
  typeof sendVisitMessageResultSchema
>;
export type DecideWaitVisitInput = z.input<typeof decideWaitVisitInputSchema>;
export type DecisionActionContract = z.infer<
  typeof decisionActionContractSchema
>;
export type ContinueWithoutReplyInput = z.input<
  typeof continueWithoutReplyInputSchema
>;
export type AnswerQuestionInput = z.input<typeof answerQuestionInputSchema>;
export type WaitFor = (typeof waitForValues)[number];
export type VisitQuestionContract = z.infer<typeof visitQuestionSchema>;
export type WorkItemQuestionContract = z.infer<typeof workItemQuestionSchema>;
export type ListWorkItemQuestionsInput = z.input<
  typeof listWorkItemQuestionsInputSchema
>;
export type GetVisitThreadInput = z.input<typeof getVisitThreadInputSchema>;
export type VisitThreadContract = z.infer<typeof visitThreadSchema>;
