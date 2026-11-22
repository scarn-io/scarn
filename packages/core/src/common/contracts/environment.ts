import { z } from "zod";
import { envVarsSchema, storedEnvVarsSchema } from "./env-vars";
import { connectorIdsSchema } from "@scarn/sdk/connectors";
import {
  environmentNameSchema,
  environmentRuntimeSchema,
  rejectEnvironmentBranch,
} from "@scarn/sdk/environment";

export {
  environmentContentSchema,
  environmentFieldsSchema,
  environmentNameSchema,
  environmentRuntimeSchema,
  findHostSetupVar,
  hostSetupVarMessage,
  resolvedEnvironmentRefSchema,
  storedEnvironmentContentSchema,
  storedEnvironmentFieldsSchema,
  storedEnvironmentRuntimeSchema,
} from "@scarn/sdk/environment";
export type {
  EnvironmentContentInput,
  ResolvedEnvironmentRef,
  StoredEnvironmentContent as EnvironmentContent,
} from "@scarn/sdk/environment";

const namedEnvironmentRefSchema = z.strictObject({
  kind: z.literal("named"),
  name: environmentNameSchema,
});

const inlineEnvironmentRefSchema = z.strictObject(
  {
    kind: z.literal("inline"),
    runtime: environmentRuntimeSchema.optional(),
    envJson: envVarsSchema.nullish(),
    connectors: connectorIdsSchema.optional(),
  },
  { error: rejectEnvironmentBranch },
);

export const environmentRefSchema = z
  .discriminatedUnion("kind", [
    namedEnvironmentRefSchema,
    inlineEnvironmentRefSchema,
  ])
  .nullable();

export const environmentRefReadSchema = z
  .discriminatedUnion("kind", [
    namedEnvironmentRefSchema,
    inlineEnvironmentRefSchema.extend({
      envJson: storedEnvVarsSchema.nullish(),
      connectors: z.array(z.string()).optional(),
    }),
  ])
  .nullable();

export type EnvironmentRef = z.output<typeof environmentRefSchema>;
