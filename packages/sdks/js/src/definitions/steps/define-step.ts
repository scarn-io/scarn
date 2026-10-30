import { toJSONSchema } from "zod/v4/core";
import type { $ZodType } from "zod/v4/core";
import type { ZodObject, ZodRawShape, ZodType } from "zod";
import type { AnyStepFeature, FeatureResultExtensions } from "./step-features";
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
import type { EnvVarsInput } from "../../env-vars";
import type { RepoConfigInput } from "../../repo-config";
import type { EnvRecord, PromptEnvContext } from "./env";
import { compileEnvironment, type StepEnvironment } from "./runtime";
import { mergeStepMcps } from "./compile-mcps";
import type { McpHandle } from "./define-mcp";
import type { BuiltInError, ConversationResult } from "../../pipelines/types";
import {
  compileStepErrors,
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
> = {
  key: string;
  name: string;
  description?: string | null;
  version?: number;
  /**
   * Where the step runs (`runtime`), its environment variables (`vars`) and what
   * it may do to the repository (`repo`). Declare it before `agentPrompt` so
   * `TEnv` is inferred from `vars` into the prompt's `env`, which is then
   * strict: only declared, non-secret keys.
   */
  environment?: StepEnvironment<TInput["_output"], TEnv, TResult["_output"]>;
  agentPrompt:
    | string
    | ((
        context: PromptTemplateContext<
          TInput["_output"],
          PromptEnvContext<TEnv>
        >,
      ) => string);
  additionalInput?: TInput;
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

export type StepDefinitionSpec = {
  key: string;
  name: string;
  description: string | null;
  version: number;
  kind: "user_defined" | "code";
  status: "draft" | "active" | "archived";
  executionMode?: "workspace" | "no_workspace";
  /**
   * Repo-relative path of the devcontainer config to launch; `null` or omitted
   * means auto-detect. Only valid with `executionMode: "workspace"`.
   */
  devcontainerConfigPath?: string | null;
  /**
   * Identifier of the worker-supplied managed runtime (`Runtime.managed.<id>()`);
   * `null` or omitted means not managed. Only valid on a `code` step with
   * `executionMode: "workspace"` and no `devcontainerConfigPath`.
   */
  managedRuntime?: string | null;
  /**
   * Repository access. Omitted means the runtime's default (`readWrite` for
   * `workspace`, `none` for `no_workspace`), which the server resolves.
   */
  repo?: RepoConfigInput;
  prompt: string | null;
  inputSchemaJson: Record<string, unknown> | null;
  resultSchemaJson: Record<string, unknown> | null;
  opencodeMcpJson: OpenCodeMcpServers | null;
  healthChecksJson: HealthChecksInput | null;
  envJson?: EnvVarsInput | null;
  /** Error names the step declares besides the built-in ones. */
  errors?: readonly string[];
  /**
   * The step's `retry` policy for standalone Tasks. Not `retry`: that name is
   * the handle's pipeline chain method.
   */
  retryJson?: StepRetryEntry[];
  /**
   * `kind === "code"` only: the live function of a spec produced by
   * `codeStep()`. Code-step discovery (`findCodeStepInModule`) reads it to
   * find the function to run. `collect-definitions.ts` strips it from the
   * copy it pushes, since a function cannot be serialized into the push
   * request; the original spec keeps it.
   */
  // A live function reference, deliberately untyped at this boundary — its
  // real input/result types live on the `StepHandle` `codeStep()` returns,
  // not on the plain `StepDefinitionSpec` wire shape itself.
  entrypoint?: {
    // eslint-disable-next-line local/no-unknown-parameter-type
    fn: (input: unknown, context: { artifactsDir: string }) => unknown;
  };
  /** `kind === "code"` only, present after `collect-definitions.ts` has run. */
  entrypointJson?: StepDefinitionEntrypointJson | null;
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
 * no `result` and no features (a conversation step), else its effective
 * result.
 */
export type DefineStepResult<
  TResult extends ZodType,
  TFeatures extends ReadonlyArray<AnyStepFeature>,
> = ZodType extends TResult
  ? [TFeatures[number]] extends [never]
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

export function defineStep<
  TInput extends ZodType = ZodType,
  TResult extends ZodType = ZodType,
  const TFeatures extends ReadonlyArray<AnyStepFeature> = never[],
  TEnv extends EnvRecord = EnvRecord,
  const TErrors extends string = never,
>(
  config: Omit<
    DefineStepInput<TInput, TResult, TEnv>,
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

  // Merge each feature's result extension into the base schema.
  let effectiveResult: ZodType | undefined = config.result;
  for (const feature of features) {
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
            PromptEnvContext<TEnv>
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

  const {
    executionMode,
    devcontainerConfigPath,
    managedRuntime,
    envJson,
    repo,
  } = compileEnvironment(config.environment, { stepKey: config.key });
  assertStepMcpInput(config);
  const mcpFields = mergeStepMcps(config.key, {
    mcps: config.mcps,
    healthChecks: config.healthChecks,
    envJson,
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
    executionMode,
    devcontainerConfigPath,
    ...(managedRuntime !== null ? { managedRuntime } : {}),
    prompt: effectivePrompt,
    inputSchemaJson: config.additionalInput
      ? toJSONSchema(config.additionalInput as unknown as $ZodType)
      : null,
    resultSchemaJson,
    opencodeMcpJson: mcpFields.opencodeMcpJson,
    healthChecksJson: mcpFields.healthChecksJson,
    envJson: mcpFields.envJson,
    ...(repo !== undefined ? { repo } : {}),
    errors: compileStepErrors(config.key, config.errors),
    retryJson: compileStepRetry(config.key, config.retry, config.errors ?? []),
  };
  return toStepHandle(spec) as StepHandle<
    TInput["_output"],
    DefineStepResult<TResult, TFeatures>,
    TErrors
  >;
}
