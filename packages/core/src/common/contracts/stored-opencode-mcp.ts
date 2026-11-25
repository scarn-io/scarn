import { storedEnvVarsSchema } from "@scarn/core/common/contracts/env-vars";
import { managedConnectionNameSchema } from "@scarn/sdk/managed-connections";
import { z } from "zod";

const [value, inherit, secret] = storedEnvVarsSchema.element.options;
const agentOnly = { applies: z.literal("agent").default("agent") };

const sharedFields = {
  disabled: z.boolean().optional(),
  codemode: z.boolean().optional(),
  timeout: z
    .object({
      startup: z.number().optional(),
      catalog: z.number().optional(),
      execution: z.number().optional(),
    })
    .optional(),
  protocol: z.enum(["legacy", "auto", "2026-07-28"]).optional(),
  workerVars: z
    .array(
      z.discriminatedUnion("source", [
        value.extend(agentOnly),
        inherit.extend(agentOnly),
        secret.extend(agentOnly),
      ]),
    )
    .optional(),
};

const storedConnectionAuthSchema = z
  .object({ connection: managedConnectionNameSchema })
  .optional();

/** Structural MCP reads, independent of authoring caps and secret refinements. */
export const storedOpenCodeMcpServersSchema = z.record(
  z.string(),
  z.discriminatedUnion("type", [
    z.object({
      type: z.literal("local"),
      command: z.array(z.string()),
      cwd: z.string().optional(),
      environment: z.record(z.string(), z.string()).optional(),
      ...sharedFields,
    }),
    z.object({
      type: z.literal("remote"),
      url: z.string(),
      headers: z.record(z.string(), z.string()).optional(),
      oauth: z
        .union([
          z.object({
            client_id: z.string().optional(),
            client_secret: z.string().optional(),
            scope: z.string().optional(),
            callback_port: z.number().optional(),
            redirect_uri: z.string().optional(),
            auth_server_metadata_url: z.string().optional(),
          }),
          z.literal(false),
        ])
        .optional(),
      auth: storedConnectionAuthSchema,
      ...sharedFields,
    }),
    z.object({
      type: z.literal("ref"),
      name: z.string().optional(),
      auth: storedConnectionAuthSchema,
      ...sharedFields,
    }),
  ]),
);
