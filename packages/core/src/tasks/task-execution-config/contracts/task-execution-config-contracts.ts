import {
  environmentFieldsSchema,
  environmentNameSchema,
  environmentRefSchema,
} from "@scarn/core/common/contracts/environment";
import {
  connectorMcpCollisionMessage,
  findConnectorMcpCollisions,
} from "@scarn/sdk/connectors";
import {
  envVarSpecSchema,
  envVarsSchema,
} from "@scarn/core/common/contracts/env-vars";
import { healthChecksSchema } from "@scarn/core/common/contracts/health-checks";
import {
  isEnvPlaceholderValue,
  openCodeMcpServersSchema,
} from "@scarn/core/common/contracts/opencode-mcp";
import { repoConfigInputSchema } from "@scarn/core/common/contracts/repo-config";
import { uuidV7Schema } from "@scarn/core/common/contracts/uuid-v7";
import { z } from "zod";

/**
 * Write-side (strict) schemas for a task execution config (D6). Every rule a
 * new row must satisfy lives here or in `TaskExecutionConfigEntity.create`;
 * reads go through the structural schemas in
 * `task-execution-config-stored.ts` instead, so tightening a rule here never
 * makes a stored row unreadable.
 */

export {
  envVarAppliesValues,
  type EnvVarApplies,
} from "@scarn/core/common/contracts/env-vars";

/**
 * The SDK's env var entry, including `applies` (D13): which process the
 * variable reaches, `agent` by default.
 */
export const taskExecutionConfigEnvVarSchema = envVarSpecSchema;

export const taskExecutionConfigEnvVarsSchema = envVarsSchema;

export type TaskExecutionConfigEnvVar = z.output<
  typeof taskExecutionConfigEnvVarSchema
>;
export type TaskExecutionConfigEnvVarsInput = z.input<
  typeof taskExecutionConfigEnvVarsSchema
>;

/**
 * `OpenCodeMcpServers` with D10's secret rule: every `environment` value of a
 * `local` server and every `headers` value of a `remote` server is written as
 * `{env:VAR}`.
 */
export const taskExecutionConfigMcpServersSchema =
  openCodeMcpServersSchema.superRefine((servers, context) => {
    for (const [key, server] of Object.entries(servers)) {
      const [field, values] =
        server.type === "local"
          ? (["environment", server.environment] as const)
          : server.type === "remote"
            ? (["headers", server.headers] as const)
            : (["environment", undefined] as const);
      for (const [name, value] of Object.entries(values ?? {})) {
        if (isEnvPlaceholderValue(value)) continue;
        context.addIssue({
          code: "custom",
          path: [key, field, name],
          message: `must be written as {env:VAR}; a literal ${field} value would be stored in plaintext`,
        });
      }
    }
  });

export const taskExecutionConfigHealthChecksSchema = healthChecksSchema;

export const taskExecutionConfigGitSchema = repoConfigInputSchema;

export type TaskExecutionConfigGitInput = z.input<
  typeof taskExecutionConfigGitSchema
>;

/** Every override field of a config, each `null` when the repo's own config applies. */
export const taskExecutionConfigContentSchema = z
  .object({
    environment: z
      .discriminatedUnion("kind", [
        environmentFieldsSchema.extend({ kind: z.literal("inline") }),
        z.strictObject({
          kind: z.literal("named"),
          name: environmentNameSchema,
        }),
      ])
      .nullable(),
    git: taskExecutionConfigGitSchema.nullable(),
    mcp: taskExecutionConfigMcpServersSchema.nullable(),
    healthChecks: taskExecutionConfigHealthChecksSchema.nullable(),
  })
  .strict();

export type TaskExecutionConfigContentInput = z.input<
  typeof taskExecutionConfigContentSchema
>;

/**
 * A step definition's public overrides. `resolveTaskExecutionConfig` maps
 * the environment ref into the stored content and deduplicates its row.
 */
export const resolveTaskExecutionConfigInputSchema = z
  .object({
    projectId: uuidV7Schema,
    environment: environmentRefSchema.optional(),
    repo: repoConfigInputSchema.nullable().optional(),
    opencodeMcpJson: taskExecutionConfigMcpServersSchema.nullable().optional(),
    healthChecksJson: taskExecutionConfigHealthChecksSchema
      .nullable()
      .optional(),
  })
  .superRefine(rejectConnectorMcpCollisions);

/**
 * Decision 9: an inline environment's connectors and the step's own `mcps`
 * share one set of MCP server keys, so a step key may not reuse a connector
 * id. A named environment's connectors are stored server-side, so
 * `resolveStepDefinitionTaskExecutionConfig` checks them at publish and the
 * worker checks them again at startup.
 */
export function rejectConnectorMcpCollisions(
  value: {
    environment?: z.output<typeof environmentRefSchema> | undefined;
    opencodeMcpJson?: Record<string, unknown> | null | undefined;
  },
  context: z.RefinementCtx,
): void {
  if (value.environment?.kind !== "inline") return;
  const collisions = findConnectorMcpCollisions(
    value.environment.connectors ?? [],
    Object.keys(value.opencodeMcpJson ?? {}),
  );
  if (collisions.length === 0) return;
  context.addIssue({
    code: "custom",
    path: ["opencodeMcpJson"],
    message: connectorMcpCollisionMessage(collisions),
  });
}

export type ResolveTaskExecutionConfigInput = z.input<
  typeof resolveTaskExecutionConfigInputSchema
>;
