import {
  anyJsonObjectSchema,
  anyJsonValueSchema,
} from "@scarn/core/common/contracts/json";
import { resolvedEnvironmentRefSchema } from "@scarn/core/common/contracts/environment";
import { repoConfigSchema } from "@scarn/core/common/contracts/repo-config";
import { healthChecksSchema } from "@scarn/core/common/contracts/health-checks";
import { openCodeMcpServersSchema } from "@scarn/core/common/contracts/opencode-mcp";
import { uuidV7Schema } from "@scarn/core/common/contracts/uuid-v7";
import { z } from "zod";
import {
  stepDefinitionEntrypointSchema,
  toolCallJsonSchema,
} from "@scarn/core/pipeline-definitions/step-definition/contracts/step-definition-contracts";
import { workItemChangesSchema } from "@scarn/core/tasks/task/contracts/work-item-change-contracts";
import { logFeedTokenSchema } from "@scarn/core/tasks/task-log/contracts/log-feed-token-contracts";
import { grantsSchema } from "@scarn/core/tasks/task/domain/grants";
import { extraConnectorSchema } from "@scarn/core/tasks/task/contracts/task-environment-selection-contracts";
import {
  taskKindValues,
  taskRunReasonValues,
  taskRunResultStatusValues,
  taskRunStatusValues,
} from "../domain/task-run-entity";
import { managedAuthorityLossReasonValues } from "@scarn/core/connections/managed-mcp-connection/domain/managed-launch-connection-entity";

const nonEmptyStringSchema = z.string().trim().min(1);

/** A full git object ID: 40 hex characters (SHA-1) or 64 (SHA-256). */
export const gitObjectIdSchema = z
  .string()
  .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, "Expected a full git object ID");

export const taskRunSchema = z.object({
  id: uuidV7Schema,
  /** The Task this run is an attempt at. */
  taskId: uuidV7Schema,
  /** 1-based, in the order the Task's runs were started. */
  number: z.number().int().positive(),
  reason: z.enum(taskRunReasonValues),
  projectId: uuidV7Schema,
  workItemId: uuidV7Schema.nullable(),
  /** `null` runs on the repo's own config; shared with the step it came from. */
  taskExecutionConfigId: uuidV7Schema.nullable(),
  /** The step's name when the Task was created from one. */
  name: nonEmptyStringSchema.nullable(),
  kind: z.enum(taskKindValues),
  /** The run of the same step before this one, in the same pipeline run. */
  previousTaskRunId: uuidV7Schema.nullable(),
  /** The branch to start from, set by whoever created the Task. */
  baseBranch: nonEmptyStringSchema.nullable(),
  /** The full commit object ID the run checks out. */
  baseCommit: nonEmptyStringSchema.nullable(),
  /** When set, the lease a claim or heartbeat grants is this long. */
  heartbeatSeconds: z.number().int().positive().nullable(),
  status: z.enum(taskRunStatusValues),
  inputJson: anyJsonValueSchema.nullable(),
  claimedBy: z.string().trim().min(1).nullable(),
  claimedAt: z.iso.datetime().nullable(),
  lastHeartbeatAt: z.iso.datetime().nullable(),
  leaseExpiresAt: z.iso.datetime().nullable(),
  executionTimeoutSeconds: z.number().int().positive().nullable(),
  executionDeadlineAt: z.iso.datetime().nullable(),
  startedAt: z.iso.datetime().nullable(),
  completedAt: z.iso.datetime().nullable(),
  /** Set on completion and never changed afterwards. */
  resultJson: anyJsonValueSchema.nullable(),
  errorJson: anyJsonValueSchema.nullable(),
  /** The branch the worker committed to, and the branch it was created from. */
  workBranch: nonEmptyStringSchema.nullable(),
  createdFromBranch: nonEmptyStringSchema.nullable(),
  /** Whether the worker restored the previous attempt's agent session. */
  sessionRestored: z.boolean().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

/**
 * Whether the managed connections a run's launch pinned still authorize it:
 * `ok`, also for a run without managed launches, or the reason it was lost.
 */
export const managedAuthorityStatusSchema = z.union([
  z.literal("ok"),
  z.object({ lost: z.enum(managedAuthorityLossReasonValues) }),
]);

/** A heartbeat's response: the run, plus whether it still holds managed authority. */
export const taskRunHeartbeatSchema = taskRunSchema.extend({
  managedAuthority: managedAuthorityStatusSchema,
});

export const taskRunClaimSchema = z.object({
  task: taskRunSchema,
  claimToken: nonEmptyStringSchema,
  /** Write access to the run's live log feed; null when the feed is not configured. */
  logFeed: logFeedTokenSchema.nullable(),
});

export const claimTaskRunsInputSchema = z.object({
  projectId: uuidV7Schema,
  workerId: nonEmptyStringSchema,
  batchSize: z.number().int().positive().max(100).default(1),
  leaseDurationSeconds: z.number().int().positive().max(3600).default(30),
  workItemId: z.string().trim().min(1).optional(),
});

export const taskRunClaimCommandInputSchema = z.object({
  claimToken: nonEmptyStringSchema,
  leaseDurationSeconds: z.number().int().positive().max(3600).default(30),
});

export const getTaskRunWorkerContextInputSchema = z.object({
  claimToken: nonEmptyStringSchema,
});

const projectOpencodeCommandDefinitionSchema = z.object({
  name: nonEmptyStringSchema,
  description: nonEmptyStringSchema,
  run: nonEmptyStringSchema,
  cwd: z.string().trim().min(1).nullable(),
});

const projectOpencodeServiceDefinitionSchema = z.object({
  name: nonEmptyStringSchema,
  description: nonEmptyStringSchema,
  run: nonEmptyStringSchema,
  cwd: z.string().trim().min(1).nullable(),
  dependsOn: z.array(nonEmptyStringSchema),
  expose: z.object({
    targetPort: z.number().int().positive().max(65_535),
    protocol: z.enum(["tcp", "http"]),
  }),
});

export const taskRunWorkerContextSchema = z.object({
  projectId: uuidV7Schema,
  /**
   * The project's `<ownerUsername>/<slug>` path in the web app, from which
   * work item page URLs are built; null while the owner has no username.
   */
  projectPath: nonEmptyStringSchema.nullable(),
  gitUrl: nonEmptyStringSchema,
  // The branch this task starts from: the Task's own `baseBranch` (set by
  // whoever created it), or the previous run's work branch when continuing a
  // conversation. Null when neither is set — the worker then uses the source
  // branch, its repo-local configured base branch, or the cloned default.
  baseWorkBranch: z.string().trim().min(1).nullable(),
  /**
   * The full commit object ID this run checks out, pinned the first time a
   * chat ran (`POST /task-runs/:id/base-commit`) and copied onto every later
   * run. Null until pinned, and for runs that don't pin.
   */
  baseCommit: nonEmptyStringSchema.nullable(),
  projectOpencodeConfig: z.object({
    relativePath: nonEmptyStringSchema,
    present: z.boolean(),
    commands: z.array(projectOpencodeCommandDefinitionSchema),
    services: z.array(projectOpencodeServiceDefinitionSchema),
  }),
  task: z.object({
    id: uuidV7Schema,
    status: z.enum(taskRunStatusValues),
    kind: z.enum(taskKindValues),
    key: nonEmptyStringSchema,
    name: nonEmptyStringSchema,
    inputJson: anyJsonValueSchema.nullable(),
    executionTimeoutSeconds: z.number().int().positive().nullable(),
    // Null for `kind === "code"` and `"mcp_tool"` tasks, which do real work
    // via a plain function or a direct tool call instead of an LLM prompt.
    prompt: nonEmptyStringSchema.nullable(),
    /** `kind === "code"` only — see `stepDefinitionEntrypointSchema`. */
    entrypointJson: stepDefinitionEntrypointSchema.nullable(),
    /** `kind === "mcp_tool"` only — see `toolCallJsonSchema`. */
    toolCall: toolCallJsonSchema.nullable(),
    resultSchemaJson: anyJsonObjectSchema.nullable(),
    /**
     * The error names the Task's step definition declares, besides the
     * built-in ones; empty for a Task with no step definition. A code step's
     * thrown `StepError` may use only these or a built-in name.
     */
    declaredErrors: z.array(nonEmptyStringSchema),
    /**
     * How many more times the agent may hand the conversation to a person:
     * its Task's `maxTurns` minus its continuation runs; null for a Task with
     * no turns.
     */
    turnsRemaining: z.number().int().nonnegative().nullable(),
    /** The Task's work item: what the `self` scope covers; null for a chat. */
    workItemId: uuidV7Schema.nullable(),
    /** A chat's (repo conversation's) conversation; null for any other Task. */
    conversationId: uuidV7Schema.nullable(),
    /** What the agent's tools may do (`taskGrants`). */
    grants: grantsSchema,
  }),
  runtime: z.object({
    environment: resolvedEnvironmentRefSchema,
    repo: repoConfigSchema,
    healthChecksJson: healthChecksSchema.nullable(),
    opencodeMcpJson: openCodeMcpServersSchema.nullable(),
    /**
     * Catalog connectors this run's Task adds on top of its environment's,
     * each with the project secret behind every var it needs. Their ids never
     * collide with the environment's connectors or the step's `mcps`.
     */
    extraConnectors: z.array(extraConnectorSchema),
  }),
  agentPrompt: z.object({
    sessionTitle: nonEmptyStringSchema,
    promptText: nonEmptyStringSchema,
    instructionsPlaceholder: nonEmptyStringSchema,
  }),
  /**
   * Set only when this Task has a message of its own: the run of the same step
   * before it. The worker writes the previous run's transcript and findings to
   * the relative paths, which the prompt already names.
   */
  previousRun: z
    .object({
      taskRunId: uuidV7Schema,
      status: z.enum(taskRunStatusValues),
      transcriptRelativePath: nonEmptyStringSchema,
      findingsRelativePath: nonEmptyStringSchema,
      findingsJson: anyJsonValueSchema.nullable(),
    })
    .nullable(),
  /**
   * Set when this Task continues the conversation its previous Task handed
   * over and that Task saved its agent session: a presigned GET URL for the export, and
   * the message to send into the restored session. Null otherwise; the
   * worker then prompts from `agentPrompt`, as it does when the restore fails.
   */
  restoreSession: z
    .object({
      downloadUrl: nonEmptyStringSchema,
      message: nonEmptyStringSchema,
    })
    .nullable(),
});

/**
 * A worker reports the commit it resolved for a chat run's branch. The first
 * report wins; `baseBranch` is stored the same way when the run has none.
 */
export const reportTaskRunBaseCommitInputSchema = z.object({
  claimToken: nonEmptyStringSchema,
  baseCommit: gitObjectIdSchema,
  baseBranch: nonEmptyStringSchema.optional(),
});

/** The run's pinned commit and branch after a report: the stored values. */
export const taskRunBaseCommitSchema = z.object({
  baseCommit: gitObjectIdSchema,
  baseBranch: nonEmptyStringSchema.nullable(),
});

export const completeClaimedTaskRunInputSchema = z.object({
  claimToken: nonEmptyStringSchema,
  status: z.enum(taskRunResultStatusValues),
  resultJson: anyJsonValueSchema,
  errorJson: anyJsonValueSchema.nullable(),
  // Branch-per-step: the `scarn/...` branch the agent committed to and the
  // branch it was created off of, persisted on the Task. Optional +
  // nullable: a step that wrote no branch (e.g. `readOnly`) reports null.
  workBranch: z.string().trim().min(1).nullable().optional(),
  createdFromBranch: z.string().trim().min(1).nullable().optional(),
  // Whether the worker restored the previous attempt's agent session; null
  // when there was nothing to restore.
  sessionRestored: z.boolean().nullable().optional(),
  // The work item changes the agent's tools recorded during the run, applied
  // only when the run succeeded and its log archive was written.
  workItemChanges: workItemChangesSchema.optional(),
});

/**
 * The agent ended its turn with a yield; the run ends `yielded` and the
 * conversation goes to a person. `message` is the turn's final text.
 */
export const yieldClaimedTaskRunInputSchema = z.object({
  claimToken: nonEmptyStringSchema,
  message: nonEmptyStringSchema,
  workBranch: z.string().trim().min(1).nullable().optional(),
  createdFromBranch: z.string().trim().min(1).nullable().optional(),
  // Object-storage key of the exported agent session, when it was uploaded.
  sessionObjectKey: z.string().trim().min(1).nullable().optional(),
  // Size in bytes of the uploaded session export; metered and stored with it.
  sessionSizeBytes: z.number().int().nonnegative().nullable().optional(),
  sessionRestored: z.boolean().nullable().optional(),
});

/** Request for a presigned PUT URL for the Task's exported agent session. */
export const createSessionUploadUrlInputSchema = z.object({
  claimToken: nonEmptyStringSchema,
  /** The export's size, so the write pre-flight can check storage headroom. */
  sizeBytes: z.number().int().nonnegative().optional(),
});

export const sessionUploadUrlSchema = z.object({
  uploadUrl: nonEmptyStringSchema,
  objectKey: nonEmptyStringSchema,
  expiresInSeconds: z.number().int().positive(),
});

export const getTaskRunInputSchema = uuidV7Schema;
export const listTaskRunsByProjectIdInputSchema = uuidV7Schema;

export type TaskRunContract = z.infer<typeof taskRunSchema>;
export type TaskRunHeartbeatContract = z.infer<typeof taskRunHeartbeatSchema>;
export type TaskRunClaimContract = z.infer<typeof taskRunClaimSchema>;
export type ClaimTaskRunsInput = z.input<typeof claimTaskRunsInputSchema>;
export type TaskRunClaimCommandInput = z.input<
  typeof taskRunClaimCommandInputSchema
>;
export type GetTaskRunWorkerContextInput = z.input<
  typeof getTaskRunWorkerContextInputSchema
>;
export type CompleteClaimedTaskRunInput = z.input<
  typeof completeClaimedTaskRunInputSchema
>;
export type YieldClaimedTaskRunInput = z.input<
  typeof yieldClaimedTaskRunInputSchema
>;
export type CreateSessionUploadUrlInput = z.input<
  typeof createSessionUploadUrlInputSchema
>;
export type SessionUploadUrlContract = z.infer<typeof sessionUploadUrlSchema>;
export type GetTaskRunInput = z.input<typeof getTaskRunInputSchema>;
export type ListTaskRunsByProjectIdInput = z.input<
  typeof listTaskRunsByProjectIdInputSchema
>;
export type TaskRunWorkerContextContract = z.infer<
  typeof taskRunWorkerContextSchema
>;
export type ReportTaskRunBaseCommitInput = z.input<
  typeof reportTaskRunBaseCommitInputSchema
>;
export type TaskRunBaseCommitContract = z.infer<typeof taskRunBaseCommitSchema>;
