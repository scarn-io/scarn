import { startedBySchema } from "@scarn/core/common/contracts/started-by";
import { uuidV7Schema } from "@scarn/core/common/contracts/uuid-v7";
import { z } from "zod";
import { taskKindValues } from "@scarn/core/tasks/task-run/domain/task-run-entity";
import { taskStatusValues, type TaskStatus } from "../domain/task-entity";
import { taskSchema } from "./task-contracts";

export const DEFAULT_PROJECT_TASKS_LIMIT = 100;
export const MAX_PROJECT_TASKS_LIMIT = 200;
export const TASK_PROMPT_PREVIEW_LENGTH = 120;

/** Where a Task's instructions came from. */
export const taskSourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("step_definition"),
    stepDefinitionId: uuidV7Schema,
    key: z.string(),
    name: z.string(),
    version: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal("prompt"),
    /** The agent prompt's first characters. */
    promptPreview: z.string(),
  }),
  z.object({
    /** A code Task without a step definition; `name` is the Task's own. */
    kind: z.literal("code"),
    name: z.string().nullable(),
  }),
  z.object({
    /** An MCP tool Task without a step definition; `name` is the Task's own. */
    kind: z.literal("mcp_tool"),
    name: z.string().nullable(),
  }),
]);

/** The fields a Task list row or Task view header shows. */
export const taskSummaryFieldsSchema = z.object({
  /** True when the Task's conversation waits on the viewer in particular. */
  waitingOnYou: z.boolean(),
  /** The people the Task's conversation waits on; empty unless it waits on someone. */
  waitingOn: z.array(
    z.object({
      userId: uuidV7Schema,
      /** `null` when unresolved. */
      username: z.string().nullable(),
    }),
  ),
  /** The Task's conversation, once its agent first handed over. */
  conversationId: uuidV7Schema.nullable(),
  /** `null` for a Task without a work item (a chat). */
  workItem: z
    .object({
      id: uuidV7Schema,
      platformKey: z.string(),
      title: z.string(),
    })
    .nullable(),
  /**
   * The repo conversation (chat) a Task without a work item answers; `title`
   * previews its first question. `null` for any other Task.
   */
  repoConversation: z
    .object({ id: uuidV7Schema, title: z.string() })
    .nullable(),
  /**
   * The person, automation or schedule rule that started the Task; a
   * pipeline step's Task carries its run's starter.
   */
  startedBy: startedBySchema,
  /** The cron time a scheduled Task runs for (the start time for Run now); `null` otherwise. */
  scheduledFor: z.iso.datetime().nullable(),
  source: taskSourceSchema,
  /** Set when a pipeline step visit created the Task; `null` for a standalone Task. */
  pipelineRunId: uuidV7Schema.nullable(),
  /** The pipeline node of that step visit. */
  nodeId: z.string().nullable(),
});

/**
 * The newest thing a Task said: a failed Task's error, an agent's last
 * message (or, while it runs, its live log line), a code Task's last log line.
 */
export const taskLatestSchema = z.object({
  kind: z.enum(["error", "message", "log"]),
  text: z.string(),
});

export const taskSummarySchema = z
  .object({
    id: uuidV7Schema,
    projectId: uuidV7Schema,
    kind: z.enum(taskKindValues),
    name: z.string().nullable(),
    status: z.enum(taskStatusValues),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    /** The latest run's number; `null` before the first run. */
    runNumber: z.number().int().positive().nullable(),
    /**
     * From the first run's start to the latest run's end, or to the read
     * while a run is live; `null` before any run starts.
     */
    durationMs: z.number().int().nonnegative().nullable(),
    latest: taskLatestSchema.nullable(),
    /** The pipeline execution that created the Task, numbered per work item oldest first. */
    pipelineRun: z
      .object({ name: z.string(), number: z.number().int().positive() })
      .nullable(),
  })
  .extend(taskSummaryFieldsSchema.shape);

/** A Task with what its view header shows. */
export const taskDetailSchema = taskSchema.extend(
  taskSummaryFieldsSchema.shape,
);

/** The Tasks tab's status presets; together they cover every status once. */
export const TASK_STATUS_PRESETS = {
  needs_attention: ["waiting_for_person", "failed"],
  running: ["running"],
  queued: ["queued"],
  waiting_on_blockers: ["waiting_for_work", "waiting_for_concurrency_slot"],
  finished: ["succeeded", "cancelled"],
} as const satisfies Record<string, readonly TaskStatus[]>;

const queryBoolean = z.union([z.boolean(), z.stringbool()]);

const oneOrMany = <T extends z.ZodType>(schema: T) =>
  z.union([schema, z.array(schema).max(MAX_PROJECT_TASKS_LIMIT)]);

export const listProjectTasksQuerySchema = z.object({
  /** One status, or several (`status=a&status=b`). */
  status: oneOrMany(z.enum(taskStatusValues)).optional(),
  kind: z.enum(taskKindValues).optional(),
  /** Only Tasks whose conversation waits on the viewer. */
  waitingOnMe: queryBoolean.optional(),
  /** Only Tasks the viewer started. */
  startedByMe: queryBoolean.optional(),
  /** One work item, or several (`workItemId=a&workItemId=b`). */
  workItemId: oneOrMany(uuidV7Schema).optional(),
  /** Only each work item's newest Task; every chat Task stays. */
  latestPerWorkItem: queryBoolean.optional(),
  /** Leave out the Tasks of ended chats, as the inbox does. */
  excludeEndedChats: queryBoolean.optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PROJECT_TASKS_LIMIT).optional(),
  /** The previous page's `nextCursor`. */
  before: uuidV7Schema.optional(),
});

/** A project's Tasks, newest first. */
export const projectTasksPageSchema = z.object({
  tasks: z.array(taskSummarySchema),
  /** Pass as `before` for the next page; `null` on the last page. */
  nextCursor: uuidV7Schema.nullable(),
  /** How many Tasks have each status under every filter but `status` and `before`. */
  counts: z.record(z.enum(taskStatusValues), z.number().int().nonnegative()),
});

export type TaskLatestContract = z.infer<typeof taskLatestSchema>;
export type TaskStatusPreset = keyof typeof TASK_STATUS_PRESETS;
export type TaskSummaryContract = z.infer<typeof taskSummarySchema>;
export type TaskDetailContract = z.infer<typeof taskDetailSchema>;
export type ListProjectTasksQueryInput = z.input<
  typeof listProjectTasksQuerySchema
>;
export type ProjectTasksPageContract = z.infer<typeof projectTasksPageSchema>;
