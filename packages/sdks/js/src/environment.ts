import { z } from "zod";
import { devcontainerConfigPathSchema } from "./devcontainer-config-path";
import {
  envVarsSchema,
  storedEnvVarsSchema,
  type EnvVarSpec,
} from "./env-vars";
import { managedRuntimeIdSchema } from "./managed-runtimes";
import {
  connectorIdsSchema,
  findMissingConnectorVars,
  type ConnectorVarsMissing,
} from "./connectors";

export const environmentNameSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/, "must match /^[a-z0-9][a-z0-9-]*$/");

export const environmentRuntimeSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("devcontainer"),
    config: devcontainerConfigPathSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("managed"),
    id: managedRuntimeIdSchema,
  }),
  z.strictObject({ kind: z.literal("host") }),
]);

/** Environments have no branch: the step's repo `baseBranch` picks the code. */
export const rejectEnvironmentBranch: z.core.$ZodErrorMap = (issue) =>
  issue.code === "unrecognized_keys" && issue.keys.includes("branch")
    ? "environments have no branch; use the step's repo baseBranch"
    : undefined;

/**
 * The fields an environment defines, shared by an inline environment in a
 * task execution config (v3, plus `kind: "inline"`) and a named
 * environment's content (plus `description`). Strict write rules.
 */
export const environmentFieldsSchema = z.strictObject(
  {
    runtime: environmentRuntimeSchema.optional(),
    vars: envVarsSchema.optional(),
    connectors: connectorIdsSchema.optional(),
  },
  { error: rejectEnvironmentBranch },
);

type EnvironmentVarsAndRuntime = {
  runtime?: { kind: string } | undefined;
  vars?: readonly Pick<EnvVarSpec, "name" | "applies">[] | undefined;
};

/** A var that needs a container to set up, on an environment whose runtime is host. */
export const findHostSetupVar = ({
  runtime,
  vars,
}: EnvironmentVarsAndRuntime):
  Pick<EnvVarSpec, "name" | "applies"> | undefined =>
  runtime?.kind === "host"
    ? (vars ?? []).find((entry) => entry.applies !== "agent")
    : undefined;

export const hostSetupVarMessage = (
  entry: Pick<EnvVarSpec, "name" | "applies">,
): string =>
  `env var "${entry.name}" applies to '${entry.applies}', but runtime 'host' has no container to set up; use 'agent'`;

/**
 * A named environment's content as written (`PUT
 * /projects/:projectId/environments/:name`, and what `defineEnvironment`
 * compiles to): the inline environment fields plus `description`, with the
 * checks that need the whole environment (no setup vars on host, every
 * connector's required vars present).
 */
export const environmentContentSchema = environmentFieldsSchema
  .extend({ description: z.string().optional() })
  .superRefine((value, context) => {
    const setupVar = findHostSetupVar(value);
    if (setupVar !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["vars"],
        message: hostSetupVarMessage(setupVar),
      });
    }
    for (const { connector, vars } of findMissingConnectorVars(
      value.connectors ?? [],
      value.vars ?? [],
    )) {
      context.addIssue({
        code: "custom",
        path: ["connectors"],
        message: `connector "${connector}" needs ${vars.join(", ")}; add them to the environment's vars`,
      });
    }
  });

export type EnvironmentContentInput = z.input<typeof environmentContentSchema>;
/** A named environment's content after parsing: every var carries `applies`. */
export type EnvironmentContentOutput = z.output<
  typeof environmentContentSchema
>;

function rejectHostSetupVars(
  vars: EnvVarSpec[],
  ctx: z.RefinementCtx,
  path: string[],
): void {
  for (const entry of vars) {
    if (entry.applies !== "agent") {
      ctx.addIssue({
        code: "custom",
        path: [...path, entry.name, "applies"],
        message: `env "${entry.name}": applies "${entry.applies}" needs a container to set up; host has none`,
      });
    }
  }
}

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

function rejectHostSetupRef(
  ref: z.output<
    typeof inlineEnvironmentRefSchema | typeof namedEnvironmentRefSchema
  >,
  ctx: z.RefinementCtx,
): void {
  if (ref.kind === "inline" && ref.runtime?.kind === "host") {
    rejectHostSetupVars(ref.envJson ?? [], ctx, ["envJson"]);
  }
}

/** Inline refs contain compiled vars, so they retain input templates. */
export const environmentRefSchema = z
  .discriminatedUnion("kind", [
    namedEnvironmentRefSchema,
    inlineEnvironmentRefSchema,
  ])
  .superRefine(rejectHostSetupRef)
  .nullable();

/** Resolution accepts persisted/public read refs without reapplying env-var write rules. */
const inlineEnvironmentRefReadSchema = inlineEnvironmentRefSchema.extend({
  envJson: storedEnvVarsSchema.nullish(),
});

export const environmentRefReadSchema = z
  .discriminatedUnion("kind", [
    namedEnvironmentRefSchema,
    inlineEnvironmentRefReadSchema,
  ])
  .superRefine(rejectHostSetupRef)
  .nullable();

/** An inline environment as read, or a named environment's content in the same shape. */
export const inlineEnvironmentReadSchema = inlineEnvironmentRefReadSchema
  .superRefine(rejectHostSetupRef)
  .nullable();

/**
 * Read-side counterpart of `environmentFieldsSchema`: structural only, so
 * tightening a write rule never makes a stored row unreadable.
 */
export const storedEnvironmentRuntimeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("devcontainer"),
    config: z.string().optional(),
  }),
  z.object({ kind: z.literal("managed"), id: managedRuntimeIdSchema }),
  z.object({ kind: z.literal("host") }),
]);

export const storedEnvironmentFieldsSchema = z.object({
  runtime: storedEnvironmentRuntimeSchema.optional(),
  vars: storedEnvVarsSchema.optional(),
  connectors: z.array(z.string()).optional(),
});

/** Read-side shape of a named environment's content. */
export const storedEnvironmentContentSchema =
  storedEnvironmentFieldsSchema.extend({
    description: z.string().optional(),
  });

export type StoredEnvironmentContent = z.output<
  typeof storedEnvironmentContentSchema
>;

/**
 * A run's environment as the server hands it to the worker: an inline
 * environment as stored, a named environment's pinned version with its
 * content, a name the project no longer has (`notFound`), or null for the
 * repository's default.
 */
export const resolvedEnvironmentRefSchema = z
  .union([
    z.strictObject({
      kind: z.literal("inline"),
      runtime: environmentRuntimeSchema.optional(),
      envJson: storedEnvVarsSchema.nullish(),
      connectors: z.array(z.string()).optional(),
    }),
    z.strictObject({
      kind: z.literal("named"),
      name: environmentNameSchema,
      version: z.number().int().positive(),
      content: storedEnvironmentContentSchema,
    }),
    z.strictObject({
      kind: z.literal("named"),
      name: environmentNameSchema,
      notFound: z.literal(true),
    }),
  ])
  .nullable();

export type ResolvedEnvironmentRef = z.output<
  typeof resolvedEnvironmentRefSchema
>;

export type ResolvedEnvironmentRefInput = z.input<
  typeof resolvedEnvironmentRefSchema
>;

export type EnvironmentRefRead = z.input<typeof environmentRefReadSchema>;
export type EnvironmentRef = z.input<typeof environmentRefSchema>;
export type ResolvedEnvironment = {
  source: "named" | "inline" | "repo-default";
  name?: string;
  runtime:
    | { kind: "devcontainer"; config: string }
    | { kind: "managed"; id: z.infer<typeof managedRuntimeIdSchema> }
    | { kind: "host" };
  envVars: EnvVarSpec[];
  /** Catalog connector ids the environment turns on. */
  connectors: string[];
};

export class EnvironmentNotFound extends Error {
  readonly kind = "EnvironmentNotFound";
  readonly code = "SCARN_ENVIRONMENT_NOT_FOUND";

  constructor(readonly environmentName: string) {
    super(`Environment not found: ${environmentName}`);
  }
}

export class EnvironmentInvalid extends Error {
  readonly kind = "EnvironmentInvalid";
  readonly code = "SCARN_ENVIRONMENT_INVALID";

  /** `environment` is `environment <name> v<N>` for a named environment. */
  constructor(
    readonly environment: string | undefined,
    readonly issues: z.ZodError["issues"],
  ) {
    super(
      `Invalid ${environment ?? "environment reference"}: ${issues
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("; ")}`,
    );
  }
}

export class BrokenDevcontainerReference extends Error {
  readonly kind = "BrokenDevcontainerReference";
  readonly code = "SCARN_DEVCONTAINER_REFERENCE_BROKEN";

  constructor(
    readonly configPath: string,
    discoveryPaths?: readonly string[],
  ) {
    super(
      discoveryPaths
        ? `Devcontainer auto-discovery found no config; checked: ${discoveryPaths.join(", ")}`
        : `Devcontainer config not found: ${configPath}`,
    );
  }
}

export type EnvironmentError =
  | EnvironmentNotFound
  | EnvironmentInvalid
  | BrokenDevcontainerReference
  | ConnectorVarsMissing;
