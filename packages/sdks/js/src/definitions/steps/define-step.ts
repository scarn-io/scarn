import { toJSONSchema } from "zod/v4/core";
import type { $ZodType } from "zod/v4/core";
import type { ZodObject, ZodRawShape, ZodType } from "zod";
import type {
  AnyStepFeature,
  FeatureResultExtensions,
  Grant,
} from "./step-features";
import {
  createPromptTemplateContext,
  type PromptTemplateContext,
} from "./prompt-template";
import {
  stepHealthChecksInputSchema,
  type HealthChecksInput,
  type StepHealthChecksInput,
} from "../../health-checks";
import type { OpenCodeMcpServers } from "../../opencode-mcp";
import type { RepoConfigInput } from "../../repo-config";
import type { EnvRecord, PromptEnvContext } from "./env";
import {
  compileEnvironment,
  knownEnvironmentVars,
  type CompiledEnvironment,
  type InlineStepEnvironment,
  type NamedStepEnvironment,
} from "./runtime";
import {
  assertBaseBranchFitsEnvironment,
  compileRepo,
  type RepoField,
  type RepoSpec,
} from "./repo";
import { assertNoConnectorMcpCollisions, mergeStepMcps } from "./compile-mcps";
import { isEnvironmentHandle } from "../../push/code-step-lookup";
import type { McpHandle } from "./define-mcp";
import type { ArgsTemplate } from "./args-template";
import type { JsonSchema } from "../../contracts/pipeline-document/json";
import type { BuiltInError, ConversationResult } from "../../pipelines/types";
import type { StepErrorOptions } from "./step-error";
import {
  compileStepConcurrency,
  compileStepErrors,
  compileStepMaxTurns,
  compileStepRetry,
  toStepHandle,
  type StepHandle,
} from "./step-handle";

// Forces TS to eagerly resolve a computed object type (mapped type,
// conditional, or generic alias application) into its final resolved shape
// wherever it's substituted in, rather than displaying the unresolved alias
// name + type args in hovers and error messages. Also collapses no-op
// intersection members (e.g. `T & Record<never, never>`) since it recomputes
// the combined key set rather than preserving the intersection structurally.
type Prettify<T> = { [K in keyof T]: T[K] } & {};

export type DefineStepInput<
  TInput extends ZodType = ZodType,
  TResult extends ZodType = ZodType,
  TEnv extends EnvRecord = EnvRecord,
  TNamed extends NamedStepEnvironment | undefined =
    NamedStepEnvironment | undefined,
> = {
  key: string;
  name: string;
  description?: string | null;
  version?: number;
  /**
   * A named environment, by name or by `defineEnvironment` handle, or an
   * inline runtime, checkout branch and variables (`vars`). Declare it before
   * `agentPrompt` and a `repo` function so their `env` is typed from the
   * handle's or the inline `vars`: only declared, non-secret keys.
   */
  environment?: InlineStepEnvironment<TInput["_output"], TEnv> | TNamed;
  repo?: RepoField<
    TInput["_output"],
    TResult["_output"],
    RepoSpec,
    PromptEnvContext<TEnv, TNamed>
  >;
  agentPrompt:
    | string
    | ((
        context: PromptTemplateContext<
          TInput["_output"],
          PromptEnvContext<TEnv, TNamed>
        >,
      ) => string);
  input?: TInput;
  result?: TResult;
  features?: AnyStepFeature[];
  /**
   * The step's MCP servers, built with `defineMcp` and keyed by the step's
   * server key. Each contributes its server, its health checks (run before
   * `healthChecks`) and its env vars (a same-named `environment.vars` entry
   * wins).
   */
  mcps?: Record<string, McpHandle>;
  /**
   * `cli` checks and `tool` checks for plugin or built-in tools. MCP checks
   * belong on the server's `defineMcp`.
   */
  healthChecks?: StepHealthChecksInput | null;
  status?: "draft" | "active";
  /**
   * Error names this step can fail with, beyond the built-in ones. A
   * pipeline's `retry.on` and `catch.on` may name them.
   */
  errors?: readonly string[];
  /**
   * How a standalone Task of this step retries: errors named in `on` (built-in
   * or declared in `errors`) get up to `maxAttempts` more runs. A pipeline
   * step uses its node's `.retry(...)` instead.
   */
  retry?: readonly StepRetryEntry[];
  /**
   * How many times a standalone Task of this step may hand over. Omitted
   * means the server default. A pipeline step uses its node's
   * `.settings({ maxTurns })` instead.
   */
  maxTurns?: number;
  /**
   * How many live Tasks of this step may run on one work item (`max`), and
   * how many more may wait for a slot (`waiting`). Anything past that is
   * dropped. Omitted means no limit. Pipeline nodes can't override it.
   */
  concurrency?: StepConcurrency;
};

/** A step's per-work-item concurrency limit. */
export type StepConcurrency = {
  max: number;
  waiting: number;
};

/** One `retry` entry: the same shape as a pipeline node's `retry`. */
export type StepRetryEntry = {
  on: readonly string[];
  maxAttempts: number;
};

/**
 * A `kind: "code"` step's portable entrypoint, once resolved by
 * `collect-definitions.ts`: the repo-relative file that defines the step. The
 * worker finds the step inside that file by its `key`.
 */
export type StepDefinitionEntrypointJson = {
  sourceFile: string;
};

/**
 * A `kind: "mcp_tool"` step's tool call spec: the server key in
 * `opencodeMcpJson`, the tool's name on that server, the compiled args
 * template, and the catalog's JSON Schemas for the tool.
 */
export type McpToolCallSpec = {
  server: string;
  tool: string;
  argsTemplate: ArgsTemplate;
  toolSchemas: {
    input: JsonSchema;
    output: JsonSchema | null;
  };
};

export type StepDefinitionSpec = {
  key: string;
  name: string;
  description: string | null;
  version: number;
  kind: "user_defined" | "code" | "mcp_tool";
  status: "draft" | "active" | "archived";
  environment: CompiledEnvironment;
  /**
   * Repository access. Omitted means the server resolves the default; shared
   * repo resolution defaults to `readWrite` for every runtime.
   */
  repo?: RepoConfigInput;
  prompt: string | null;
  inputSchemaJson: Record<string, unknown> | null;
  resultSchemaJson: Record<string, unknown> | null;
  opencodeMcpJson: OpenCodeMcpServers | null;
  healthChecksJson: HealthChecksInput | null;
  /** Error names the step declares besides the built-in ones. */
  errors?: readonly string[];
  /**
   * The step's `retry` policy for standalone Tasks. Not `retry`: that name is
   * the handle's pipeline chain method.
   */
  retryJson?: StepRetryEntry[];
  /** How many times a standalone Task of this step may hand over; omitted means the server default. */
  maxTurns?: number;
  /** The step's per-work-item concurrency limit; omitted means no limit. */
  concurrency?: StepConcurrency;
  /**
   * What the step's Tasks may do to work items, from its
   * `Features.workItems.*` features. Every Task may also read its own.
   */
  grants?: readonly Grant[];
  /**
   * `kind === "code"` only: the live function of a spec produced by
   * `codeStep()`: the step's `fn`, wrapped to add `mcp` to its context when
   * the step declares `mcps`. The runner supplies `artifactsDir` and `fail`.
   * Code-step discovery (`findCodeStepInModule`) reads it to
   * find the function to run. `collect-definitions.ts` strips it from the
   * copy it pushes, since a function cannot be serialized into the push
   * request; the original spec keeps it.
   */
  // A live function reference, deliberately untyped at this boundary — its
  // real input/result types live on the `StepHandle` `codeStep()` returns,
  // not on the plain `StepDefinitionSpec` wire shape itself.
  entrypoint?: {
    fn: (
      // eslint-disable-next-line local/no-unknown-parameter-type
      input: unknown,
      context: {
        artifactsDir: string;
        fail: (
          name: string,
          message: string,
          options?: StepErrorOptions,
        ) => never;
      },
    ) => unknown;
  };
  /** `kind === "code"` only, present after `collect-definitions.ts` has run. */
  entrypointJson?: StepDefinitionEntrypointJson | null;
  /** `kind === "mcp_tool"` only: the one tool the step calls. */
  toolCall?: McpToolCallSpec;
};

// A step's effective result type: its own `result` schema's output merged
// with whatever its features contribute. `Prettify` collapses the
// `& Record<never, never>` that `FeatureResultExtensions` contributes when
// `features` is omitted (the common case), so hovers show the plain result
// shape instead of a redundant empty-intersection member.
// Exported so `define-code-step.ts` can give `codeStep()`'s `fn` the same
// feature-extended return type `defineStep()` gives its result schema.
export type EffectiveResult<
  TResult,
  TFeatures extends ReadonlyArray<AnyStepFeature>,
> = Prettify<TResult & FeatureResultExtensions<TFeatures>>;

/**
 * A `defineStep` handle's result type: `ConversationResult` when the step has
 * no `result` and no feature adds result fields (a conversation step), else
 * its effective result.
 */
export type DefineStepResult<
  TResult extends ZodType,
  TFeatures extends ReadonlyArray<AnyStepFeature>,
> = ZodType extends TResult
  ? [keyof FeatureResultExtensions<TFeatures>] extends [never]
    ? ConversationResult
    : EffectiveResult<TResult["_output"], TFeatures>
  : EffectiveResult<TResult["_output"], TFeatures>;

/**
 * Rejects the removed MCP authoring paths for JS callers the types don't
 * reach: `mcpServers`, and a `healthChecks` entry carrying `mcp`.
 */
function assertStepMcpInput(config: {
  key: string;
  healthChecks?: StepHealthChecksInput | null;
}): void {
  if ("mcpServers" in config) {
    throw new Error(
      `Step "${config.key}": mcpServers is not supported. Declare each MCP server with defineMcp({ type: "ref" | "local" | "remote", ... }) and list it under mcps.`,
    );
  }
  if (config.healthChecks == null) return;
  const parsed = stepHealthChecksInputSchema.safeParse(config.healthChecks);
  if (parsed.success) return;
  const issues = parsed.error.issues
    .map((issue) =>
      issue.path.length > 0
        ? `${issue.path.map(String).join(".")}: ${issue.message}`
        : issue.message,
    )
    .join("; ");
  throw new Error(
    `Step "${config.key}" healthChecks: ${issues}. MCP health checks are declared on the server with defineMcp({ healthChecks }).`,
  );
}

/** The grants a step's features carry, at most one per resource, action and scope. */
function collectGrants(
  stepKey: string,
  features: readonly AnyStepFeature[],
): Grant[] {
  const grants: Grant[] = [];
  const seen = new Set<string>();
  for (const feature of features) {
    const grant = feature._grant;
    if (!grant) continue;
    const key = `${grant.resource}:${grant.action}:${grant.scope}`;
    if (seen.has(key)) {
      throw new Error(
        `Step "${stepKey}": more than one Features.${grant.resource}s.${grant.action}({ scope: "${grant.scope}" }). Attach each work item grant once.`,
      );
    }
    seen.add(key);
    grants.push(
      "labels" in grant
        ? { ...grant, labels: [...grant.labels] }
        : { ...grant },
    );
  }
  return grants;
}

export function defineStep<
  TInput extends ZodType = ZodType,
  TResult extends ZodType = ZodType,
  const TFeatures extends ReadonlyArray<AnyStepFeature> = never[],
  TEnv extends EnvRecord = EnvRecord,
  const TErrors extends string = never,
  TNamed extends NamedStepEnvironment | undefined = undefined,
>(
  config: Omit<
    DefineStepInput<TInput, TResult, TEnv, TNamed>,
    "features" | "errors" | "retry"
  > & {
    features?: TFeatures;
    errors?: readonly TErrors[];
    retry?: readonly {
      on: readonly (BuiltInError | TErrors)[];
      maxAttempts: number;
    }[];
  },
): StepHandle<
  TInput["_output"],
  DefineStepResult<TResult, TFeatures>,
  TErrors
> {
  const features = (config.features ?? []) as AnyStepFeature[];
  const grants = collectGrants(config.key, features);

  // Merge each feature's result extension into the base schema.
  let effectiveResult: ZodType | undefined = config.result;
  for (const feature of features) {
    if (!feature._resultExtension) continue;
    effectiveResult = effectiveResult
      ? (effectiveResult as ZodObject<ZodRawShape>).extend(
          feature._resultExtension.shape,
        )
      : feature._resultExtension;
  }

  const basePrompt =
    typeof config.agentPrompt === "function"
      ? config.agentPrompt(
          createPromptTemplateContext<
            TInput["_output"],
            PromptEnvContext<TEnv, TNamed>
          >(),
        )
      : config.agentPrompt;

  // Append each feature's prompt addition.
  let effectivePrompt: string = basePrompt;
  for (const feature of features) {
    if (feature._promptAddition) {
      effectivePrompt = effectivePrompt
        ? `${effectivePrompt}\n\n${feature._promptAddition}`
        : feature._promptAddition;
    }
  }

  const environment = compileEnvironment(config.environment, {
    stepKey: config.key,
  });
  const repo = compileRepo(config.repo, { stepKey: config.key });
  assertBaseBranchFitsEnvironment(
    repo,
    knownEnvironmentVars(config.environment, environment),
    { stepKey: config.key },
  );
  assertStepMcpInput(config);
  assertNoConnectorMcpCollisions(config.key, config.environment, config.mcps);
  const mcpFields = mergeStepMcps(config.key, {
    mcps: config.mcps,
    healthChecks: config.healthChecks,
    envJson: environment?.kind === "inline" ? environment.envJson : null,
  });

  const resultSchemaJson = effectiveResult
    ? toJSONSchema(effectiveResult as unknown as $ZodType)
    : null;

  const spec: StepDefinitionSpec = {
    key: config.key,
    name: config.name,
    description: config.description ?? null,
    version: config.version ?? 1,
    kind: "user_defined",
    status: config.status ?? "active",
    environment,
    prompt: effectivePrompt,
    inputSchemaJson: config.input
      ? toJSONSchema(config.input as unknown as $ZodType)
      : null,
    resultSchemaJson,
    opencodeMcpJson: mcpFields.opencodeMcpJson,
    healthChecksJson: mcpFields.healthChecksJson,
    ...(repo !== undefined ? { repo } : {}),
    errors: compileStepErrors(config.key, config.errors),
    retryJson: compileStepRetry(config.key, config.retry, config.errors ?? []),
    ...(config.maxTurns !== undefined
      ? { maxTurns: compileStepMaxTurns(config.key, config.maxTurns) }
      : {}),
    ...(config.concurrency !== undefined
      ? {
          concurrency: compileStepConcurrency(config.key, config.concurrency),
        }
      : {}),
    ...(grants.length > 0 ? { grants } : {}),
  };
  return toStepHandle(
    spec,
    isEnvironmentHandle(config.environment) ? config.environment : undefined,
  ) as StepHandle<
    TInput["_output"],
    DefineStepResult<TResult, TFeatures>,
    TErrors
  >;
}
