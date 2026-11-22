import { anyJsonValueSchema } from "@scarn/core/common/contracts/json";
import { uuidV7Schema } from "@scarn/core/common/contracts/uuid-v7";
import { z } from "zod";
import { taskKindValues } from "@scarn/core/tasks/task-run/domain/task-run-entity";
import { taskRunSchema } from "@scarn/core/tasks/task-run/contracts/task-run-contracts";
import { taskStatusValues } from "../domain/task-entity";
import { grantsSchema } from "../domain/grants";
import {
  taskEnvironmentInputSchema,
  taskEnvironmentSelectionSchema,
} from "./task-environment-selection-contracts";

const nonEmptyStringSchema = z.string().trim().min(1);

export const taskSchema = z.object({
  id: uuidV7Schema,
  projectId: uuidV7Schema,
  /** Null for a chat Task, which has a conversation instead. */
  workItemId: uuidV7Schema.nullable(),
  /** The step definition the instructions were copied from, if any. */
  stepDefinitionId: uuidV7Schema.nullable(),
  kind: z.enum(taskKindValues),
  name: nonEmptyStringSchema.nullable(),
  /** `null` runs on the repo's own config; shared with the step it came from. */
  taskExecutionConfigId: uuidV7Schema.nullable(),
  /** The extra connectors the Task adds on top of its environment's; null when none. */
  environmentSelection: taskEnvironmentSelectionSchema.nullable(),
  inputJson: anyJsonValueSchema.nullable(),
  /** The pipeline node's `retry` list, when a step visit created the Task. */
  retryJson: anyJsonValueSchema.nullable(),
  /** What the agent may do: the step definition's grants plus `read` on `self`. */
  grants: grantsSchema,
  /** How many times the agent may hand over: the pipeline node's `maxTurns`, or a standalone Task's step definition's (default 20). */
  maxTurns: z.number().int().nonnegative().nullable(),
  heartbeatSeconds: z.number().int().positive().nullable(),
  executionTimeoutSeconds: z.number().int().positive().nullable(),
  /** Set when the Task is created; not yet kept in step with its runs. */
  status: z.enum(taskStatusValues),
  resultJson: anyJsonValueSchema.nullable(),
  errorJson: anyJsonValueSchema.nullable(),
  startedByUserId: uuidV7Schema.nullable(),
  previousTaskId: uuidV7Schema.nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

const createTaskSharedShape = {
  projectId: uuidV7Schema,
  workItemId: uuidV7Schema,
  inputJson: anyJsonValueSchema.nullable().optional(),
  executionTimeoutSeconds: z.number().int().positive().nullable().optional(),
  environment: taskEnvironmentInputSchema.optional(),
};

/**
 * A new Task, created either from a step-definition version or from a
 * prompt (an `agent` Task on the repo's own config), never both.
 * `environment` may name a named environment to run in instead of the
 * step's own or the repo default, and add catalog connectors. A prompt
 * Task clones the repo `readOnly` unless `repoWrite` lets it commit and
 * push a new work branch.
 */
export const createTaskInputSchema = z.union([
  z
    .object({
      ...createTaskSharedShape,
      stepDefinitionId: uuidV7Schema,
      stepDefinitionVersion: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      ...createTaskSharedShape,
      prompt: nonEmptyStringSchema,
      repoWrite: z.boolean().default(false),
    })
    .strict(),
]);

/** `run` is null when the work item is blocked and the Task is `waiting_for_work`. */
export const createdTaskSchema = z.object({
  task: taskSchema,
  run: taskRunSchema.nullable(),
});

/** A Task's runs, oldest first. */
export const taskRunsListSchema = z.array(taskRunSchema);

export const getTaskInputSchema = uuidV7Schema;

export const retryTaskInputSchema = z
  .object({
    taskId: uuidV7Schema,
    expectedLatestRunId: uuidV7Schema.nullable(),
  })
  .strict();

export const retriedTaskSchema = z.object({
  taskId: uuidV7Schema,
  taskRunId: uuidV7Schema.nullable(),
});

export type RetryTaskInput = z.input<typeof retryTaskInputSchema>;
export type RetriedTaskContract = z.infer<typeof retriedTaskSchema>;

export type TaskContract = z.infer<typeof taskSchema>;
export type CreateTaskInput = z.input<typeof createTaskInputSchema>;
export type CreatedTaskContract = z.infer<typeof createdTaskSchema>;
export type GetTaskInput = z.input<typeof getTaskInputSchema>;
