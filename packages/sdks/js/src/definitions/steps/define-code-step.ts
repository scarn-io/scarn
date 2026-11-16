import { toJSONSchema } from "zod/v4/core";
import type { $ZodType } from "zod/v4/core";
import type { ZodObject, ZodRawShape, ZodType } from "zod";
import type {
  EffectiveResult,
  StepConcurrency,
  StepDefinitionSpec,
  StepRetryEntry,
} from "./define-step";
import type { BuiltInError } from "../../pipelines/types";
import {
  compileStepConcurrency,
  compileStepErrors,
  compileStepRetry,
  toStepHandle,
  type StepHandle,
} from "./step-handle";
import { DEFAULT_CODE_STEP_RUNTIME_ID } from "../../managed-runtimes";
import {
  compileEnvironment,
  knownEnvironmentVars,
  Runtime,
  type InlineCodeStepEnvironment,
  type NamedStepEnvironment,
} from "./runtime";
import type { EnvRecord, PromptEnvContext } from "./env";
import type { CodeStepFeature } from "./step-features";
import {
  assertBaseBranchFitsEnvironment,
  compileRepo,
  type RepoField,
  type RepoSpec,
} from "./repo";
import { isEnvironmentHandle } from "../../push/code-step-lookup";

/** What the worker passes a code step besides its input. */
export type CodeStepContext = {
  /**
   * Absolute path of the step-artifacts folder, which already exists. Write
   * a file here and return its path relative to this folder with
   * `Artifact.path(...)` to fill an artifact field.
   */
  artifactsDir: string;
};

export type CodeStepFn<TInput, TResult> = (
  input: TInput,
  context: CodeStepContext,
) => TResult | Promise<TResult>;

export type DefineCodeStepInput<
  TInput extends ZodType = ZodType,
  TResult extends ZodType = ZodType,
  TFeatures extends ReadonlyArray<CodeStepFeature> = never[],
  TEnv extends EnvRecord = EnvRecord,
  TNamed extends NamedStepEnvironment | undefined =
    NamedStepEnvironment | undefined,
> = {
  key: string;
  name: string;
  description?: string | null;
  version?: number;
  /**
   * The step's own implementation. It may be an inline arrow or a reference
   * to a function declared elsewhere; it does not need to be exported. Only
   * the file that defines the step is pushed (as `{ sourceFile }`), and the
   * worker re-imports that file from the repo checkout and finds the step by
   * `key`, so closures and module-level helpers keep working. The step must
   * be exported by name from that file.
   *
   * Typed against `EffectiveResult`, not the bare `resultSchema` output, so
   * a step with `features: [Features.notifications()]` can return the
   * `$scarn_notifications_v1` field (e.g. via `Notify.inApp(...)`)
   * without a type error.
   */
  fn: CodeStepFn<
    TInput["_output"],
    EffectiveResult<TResult["_output"], TFeatures>
  >;
  inputSchema?: TInput;
  resultSchema?: TResult;
  /**
   * Step features to attach — unlike `defineStep()`, only each feature's
   * `_resultExtension` applies here (there is no prompt to append
   * to on a `kind: "code"` step). `Features.workItems.*` is rejected: a code
   * step has no agent tools to use a grant with.
   */
  features?: TFeatures;
  /**
   * A named environment (its name or `defineEnvironment` handle), or inline
   * runtime and environment variables (`vars`).
   * The function reads the variables back through `process.env`; unlike
   * `defineStep()`, there is no typed `env` argument to `fn`.
   *
   * For an inline environment, omitting `runtime` compiles to
   * `Runtime.managed.bun1()`, a worker-supplied container.
   * `Runtime.devcontainer()` opts into the project's own container, which must
   * then provide a JS runtime for the runner script.
   *
   * `Runtime.host()` is not supported: a code step runs repo code, so it needs
   * a workspace, and the host runtime has none. It is a type error here and
   * `validateDefinitionSpecs` rejects it for hand-built specs.
   * A handle whose runtime is host throws here; a name's runtime is checked by
   * the worker after resolution.
   *
   * `repo` follows the same rules as for `defineStep()`; `result` is typed from
   * `resultSchema`.
   */
  environment?: InlineCodeStepEnvironment<TInput["_output"], TEnv> | TNamed;
  /** `env` is typed from the environment as `defineStep()`'s prompt `env` is. */
  repo?: RepoField<
    TInput["_output"],
    TResult["_output"],
    RepoSpec,
    PromptEnvContext<TEnv, TNamed>
  >;
  status?: "draft" | "active";
  /**
   * Error names this step can fail with, beyond the built-in ones. A
   * pipeline's `retry.on` and `catch.on` may name them.
   */
  errors?: readonly string[];
  /** As `defineStep()`'s `retry`: how a standalone Task of this step retries. */
  retry?: readonly StepRetryEntry[];
  /** As `defineStep()`'s `concurrency`: the per-work-item concurrency limit. */
  concurrency?: StepConcurrency;
};

/**
 * Defines a `kind: "code"` step: a plain function instead of an LLM
 * prompt. Produces the same callable step handle `defineStep()` does (so a
 * pipeline calls it the same way), but with no `prompt` and a live
 * `entrypoint.fn` reference attached instead — see `StepDefinitionSpec`'s
 * own doc comment for what happens to it during collection.
 */
export function codeStep<
  TInput extends ZodType = ZodType,
  TResult extends ZodType = ZodType,
  const TFeatures extends ReadonlyArray<CodeStepFeature> = never[],
  const TErrors extends string = never,
  TEnv extends EnvRecord = EnvRecord,
  TNamed extends NamedStepEnvironment | undefined = undefined,
>(
  config: Omit<
    DefineCodeStepInput<TInput, TResult, TFeatures, TEnv, TNamed>,
    "errors" | "retry"
  > & {
    errors?: readonly TErrors[];
    retry?: readonly {
      on: readonly (BuiltInError | TErrors)[];
      maxAttempts: number;
    }[];
  },
): StepHandle<
  TInput["_output"],
  EffectiveResult<TResult["_output"], TFeatures>,
  TErrors
> {
  const features = (config.features ?? []) as CodeStepFeature[];

  // Merge each feature's result extension into the base schema — same
  // approach as `defineStep()`, minus the prompt-append step (code steps
  // have no prompt).
  let effectiveResult: ZodType | undefined = config.resultSchema;
  for (const feature of features) {
    if (!feature._resultExtension) continue;
    effectiveResult = effectiveResult
      ? (effectiveResult as ZodObject<ZodRawShape>).extend(
          feature._resultExtension.shape,
        )
      : feature._resultExtension;
  }

  const environmentHandle = isEnvironmentHandle(config.environment)
    ? config.environment
    : undefined;
  if (environmentHandle?.content.runtime?.kind === "host") {
    throw new Error(
      `Step "${config.key}" environment "${environmentHandle.name}": a code step needs a container, but the environment's runtime is Runtime.host(). Use Runtime.managed.bun1() or Runtime.devcontainer().`,
    );
  }
  const environment = compileEnvironment(config.environment, {
    stepKey: config.key,
    defaultRuntime: Runtime.managed[DEFAULT_CODE_STEP_RUNTIME_ID](),
  });
  const repo = compileRepo(config.repo, { stepKey: config.key });
  assertBaseBranchFitsEnvironment(
    repo,
    knownEnvironmentVars(config.environment, environment),
    { stepKey: config.key },
  );

  const spec: StepDefinitionSpec = {
    key: config.key,
    name: config.name,
    description: config.description ?? null,
    version: config.version ?? 1,
    kind: "code",
    status: config.status ?? "active",
    environment,
    prompt: null,
    inputSchemaJson: config.inputSchema
      ? toJSONSchema(config.inputSchema as unknown as $ZodType)
      : null,
    resultSchemaJson: effectiveResult
      ? toJSONSchema(effectiveResult as unknown as $ZodType)
      : null,
    opencodeMcpJson: null,
    healthChecksJson: null,
    ...(repo !== undefined ? { repo } : {}),
    errors: compileStepErrors(config.key, config.errors),
    retryJson: compileStepRetry(config.key, config.retry, config.errors ?? []),
    ...(config.concurrency !== undefined
      ? {
          concurrency: compileStepConcurrency(config.key, config.concurrency),
        }
      : {}),
    entrypoint: { fn: config.fn },
  };

  return toStepHandle(spec, environmentHandle) as StepHandle<
    TInput["_output"],
    EffectiveResult<TResult["_output"], TFeatures>,
    TErrors
  >;
}
