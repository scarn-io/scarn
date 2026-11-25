import {
  environmentRefReadSchema,
  environmentRefSchema,
} from "@scarn/core/common/contracts/environment";
import {
  anyJsonObjectSchema,
  anyJsonValueSchema,
} from "@scarn/core/common/contracts/json";
import {
  healthChecksSchema,
  type HealthCheck,
} from "@scarn/core/common/contracts/health-checks";
import {
  repoConfigInputSchema,
  repoConfigSchema,
} from "@scarn/core/common/contracts/repo-config";
import { openCodeMcpServersSchema } from "@scarn/core/common/contracts/opencode-mcp";
import { uuidV7Schema } from "@scarn/core/common/contracts/uuid-v7";
import { z } from "zod";
import { BUILT_IN_ERRORS } from "@scarn/sdk/contracts/pipeline-document";
import {
  rejectConnectorMcpCollisions,
  taskExecutionConfigMcpServersSchema,
} from "@scarn/core/tasks/task-execution-config/contracts/task-execution-config-contracts";
import {
  grantKindRefusals,
  grantsSchema,
} from "@scarn/core/tasks/task/domain/grants";
import {
  stepDefinitionKindValues,
  stepDefinitionStatusValues,
} from "../domain/step-definition-entity";

const nonEmptyStringSchema = z.string().trim().min(1);

/**
 * A `kind: "code"` step's portable entrypoint — mirrors
 * `StepDefinitionEntrypoint` in `domain/step-definition-entity.ts` verbatim.
 */
export const stepDefinitionEntrypointSchema = z.object({
  sourceFile: nonEmptyStringSchema,
});

const storedJsonSchemaSchema = z.union([anyJsonObjectSchema, z.boolean()]);

/**
 * A `kind: "mcp_tool"` step's tool call spec — mirrors
 * `StepDefinitionToolCall` in `domain/step-definition-entity.ts`.
 */
export const toolCallJsonSchema = z.strictObject({
  server: nonEmptyStringSchema,
  tool: nonEmptyStringSchema,
  argsTemplate: anyJsonValueSchema,
  toolSchemas: z.strictObject({
    input: storedJsonSchemaSchema,
    output: storedJsonSchemaSchema.nullable(),
  }),
});

/**
 * One `retry` entry a step definition gives its standalone Tasks: retry
 * errors named in `on` up to `maxAttempts` times. The same shape as a
 * pipeline node's `retry`, without the delay fields v1 doesn't support.
 */
export const stepRetryEntrySchema = z.strictObject({
  on: z.array(nonEmptyStringSchema).min(1),
  maxAttempts: z.number().int().positive(),
});

/**
 * A step's per-work-item concurrency limit: at most `max` live Tasks of the
 * step run on one work item, and up to `waiting` more wait for a slot.
 */
export const stepConcurrencySchema = z.strictObject({
  max: z.number().int().min(1),
  waiting: z.number().int().min(0),
});

export const stepDefinitionSchema = z.object({
  id: uuidV7Schema,
  projectId: uuidV7Schema,
  key: nonEmptyStringSchema,
  name: nonEmptyStringSchema,
  description: z.string().trim().min(1).nullable(),
  prompt: z.string().trim().min(1).nullable(),
  version: z.number().int().positive(),
  kind: z.enum(stepDefinitionKindValues),
  /** `kind === "code"` only — see `stepDefinitionEntrypointSchema`. */
  entrypointJson: stepDefinitionEntrypointSchema.nullable(),
  /** `kind === "mcp_tool"` only — see `toolCallJsonSchema`. */
  toolCallJson: toolCallJsonSchema.nullable(),
  environment: environmentRefReadSchema,
  inputSchemaJson: anyJsonObjectSchema,
  /** Null: a conversation step (agent steps only). */
  resultSchemaJson: anyJsonObjectSchema.nullable(),
  errors: z.array(nonEmptyStringSchema),
  retry: z.array(stepRetryEntrySchema),
  /** What a Task of this step may do; every Task also gets `read` on `self`. */
  grants: grantsSchema,
  /** How many times a standalone Task of this step may hand over; null for the default (20). */
  maxTurns: z.number().int().positive().nullable(),
  /** The per-work-item concurrency limit; null for no limit. */
  concurrency: stepConcurrencySchema.nullable(),
  opencodeMcpJson: openCodeMcpServersSchema.nullable(),
  healthChecksJson: healthChecksSchema.nullable(),
  repo: repoConfigSchema,
  status: z.enum(stepDefinitionStatusValues),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

/**
 * The `mcp_tool` shape, mirroring the SDK's `checkMcpToolSteps`: a tool call
 * naming the step's one MCP server, a result schema, and no prompt,
 * entrypoint or health checks. Other kinds carry no tool call.
 */
const refineMcpToolStep = (
  value: {
    kind: (typeof stepDefinitionKindValues)[number];
    prompt?: string | null | undefined;
    entrypointJson?: unknown;
    toolCallJson?: z.infer<typeof toolCallJsonSchema> | null | undefined;
    resultSchemaJson: unknown;
    opencodeMcpJson?: Record<string, unknown> | null | undefined;
    healthChecksJson?: readonly unknown[] | null | undefined;
  },
  context: z.RefinementCtx,
): void => {
  const issue = (message: string, path: string) => {
    context.addIssue({ code: "custom", message, path: [path] });
  };
  if (value.kind !== "mcp_tool") {
    if (value.toolCallJson != null) {
      issue(
        `Step definition of kind '${value.kind}' must not have toolCallJson`,
        "toolCallJson",
      );
    }
    return;
  }
  const toolCall = value.toolCallJson;
  if (!toolCall) {
    issue(
      "Step definition of kind 'mcp_tool' requires toolCallJson",
      "toolCallJson",
    );
  } else {
    const servers = Object.keys(value.opencodeMcpJson ?? {});
    if (servers.length !== 1 || servers[0] !== toolCall.server) {
      issue(
        `Step definition of kind 'mcp_tool' must declare exactly one MCP server, the one its tool call names ("${toolCall.server}")`,
        "opencodeMcpJson",
      );
    }
  }
  if (value.prompt?.trim()) {
    issue(
      "Step definition of kind 'mcp_tool' must not have a prompt",
      "prompt",
    );
  }
  if (value.entrypointJson != null) {
    issue(
      "Step definition of kind 'mcp_tool' must not have entrypointJson",
      "entrypointJson",
    );
  }
  if ((value.healthChecksJson ?? []).length > 0) {
    issue(
      "Step definition of kind 'mcp_tool' runs no health checks",
      "healthChecksJson",
    );
  }
  if (value.resultSchemaJson === null) {
    issue(
      "Step definition of kind 'mcp_tool' requires a result schema",
      "resultSchemaJson",
    );
  }
};

/**
 * A `code` step's health checks, mirroring the SDK's code-step validation:
 * only `tool` checks on an MCP server. That the server is declared is the
 * execution config's rule (`TASK_EXECUTION_CONFIG_HEALTH_CHECK_MCP_UNKNOWN`).
 */
const refineCodeStepHealthChecks = (
  value: {
    kind: (typeof stepDefinitionKindValues)[number];
    healthChecksJson?: readonly HealthCheck[] | null | undefined;
  },
  context: z.RefinementCtx,
): void => {
  if (value.kind !== "code") return;
  (value.healthChecksJson ?? []).forEach((check, index) => {
    if (check.kind === "tool" && check.mcp !== undefined) return;
    context.addIssue({
      code: "custom",
      message:
        "Step definition of kind 'code' allows only 'tool' health checks that name one of its MCP servers",
      path: ["healthChecksJson", index],
    });
  });
};

export const createStepDefinitionInputSchema = z
  .object({
    projectId: uuidV7Schema,
    key: nonEmptyStringSchema,
    name: nonEmptyStringSchema,
    description: z.string().trim().min(1).nullable(),
    // `kind === "code"` carries no prompt (see the `superRefine` below,
    // mirroring `StepDefinitionEntity`'s own kind-specific invariant) —
    // required non-empty only for `user_defined`.
    prompt: z.string().trim().min(1).nullable().optional(),
    version: z.number().int().positive(),
    kind: z.enum(stepDefinitionKindValues),
    entrypointJson: stepDefinitionEntrypointSchema.nullable().optional(),
    /** Required for `kind === "mcp_tool"`, and not allowed on other kinds. */
    toolCallJson: toolCallJsonSchema.nullable().optional(),
    environment: environmentRefSchema.optional(),
    inputSchemaJson: anyJsonObjectSchema,
    /** Null: a conversation step; a code step requires one. */
    resultSchemaJson: anyJsonObjectSchema.nullable(),
    errors: z.array(nonEmptyStringSchema).optional(),
    retry: z.array(stepRetryEntrySchema).optional(),
    /** What a Task of this step may do; every Task also gets `read` on `self`. */
    grants: grantsSchema.optional(),
    /** How many times a standalone Task of this step may hand over; null for the default (20). */
    maxTurns: z.number().int().positive().nullable().optional(),
    /** The per-work-item concurrency limit; null for no limit. */
    concurrency: stepConcurrencySchema.nullable().optional(),
    opencodeMcpJson: taskExecutionConfigMcpServersSchema.nullable().optional(),
    healthChecksJson: healthChecksSchema.nullable().optional(),
    repo: repoConfigInputSchema.optional(),
    status: z.enum(stepDefinitionStatusValues),
  })
  .superRefine((value, context) => {
    rejectConnectorMcpCollisions(value, context);
    if (value.kind === "code" && !value.entrypointJson) {
      context.addIssue({
        code: "custom",
        message:
          "Step definition of kind 'code' requires entrypointJson: { sourceFile }",
        path: ["entrypointJson"],
      });
    }
    const knownErrors = new Set<string>([
      ...BUILT_IN_ERRORS,
      ...(value.errors ?? []),
    ]);
    (value.retry ?? []).forEach((entry, index) => {
      entry.on.forEach((name, nameIndex) => {
        if (!knownErrors.has(name)) {
          context.addIssue({
            code: "custom",
            message: `retry names "${name}", which is neither a built-in error nor one the step declares`,
            path: ["retry", index, "on", nameIndex],
          });
        }
      });
    });
    if (value.kind === "user_defined" && !value.prompt?.trim()) {
      context.addIssue({
        code: "custom",
        message: "Step definition of kind 'user_defined' requires a prompt",
        path: ["prompt"],
      });
    }
    refineMcpToolStep(value, context);
    refineCodeStepHealthChecks(value, context);
    for (const message of grantKindRefusals(value.kind, value.grants ?? [])) {
      context.addIssue({ code: "custom", message, path: ["grants"] });
    }
  });

export const upsertStepDefinitionInputSchema = createStepDefinitionInputSchema;
export const getStepDefinitionInputSchema = uuidV7Schema;
export const listStepDefinitionsByProjectIdInputSchema = uuidV7Schema;

export type StepDefinitionContract = z.infer<typeof stepDefinitionSchema>;
export type CreateStepDefinitionInput = z.input<
  typeof createStepDefinitionInputSchema
>;
export type UpsertStepDefinitionInput = z.input<
  typeof upsertStepDefinitionInputSchema
>;
export type GetStepDefinitionInput = z.input<
  typeof getStepDefinitionInputSchema
>;
export type ListStepDefinitionsByProjectIdInput = z.input<
  typeof listStepDefinitionsByProjectIdInputSchema
>;
