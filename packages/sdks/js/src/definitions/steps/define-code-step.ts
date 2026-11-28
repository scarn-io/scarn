import { toJSONSchema } from "zod/v4/core";
import type { $ZodType } from "zod/v4/core";
import type { ZodObject, ZodRawShape, ZodType } from "zod";
import type {
  EffectiveResult,
  StepConcurrency,
  StepDefinitionSpec,
  StepLogs,
  StepRetryEntry,
} from "./define-step";
import type { BuiltInError } from "../../pipelines/types";
import {
  compileStepConcurrency,
  compileStepErrors,
  compileStepLogs,
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
import type { CodeStepFeature, FeatureGrants, Grant } from "./step-features";
import { hasGrantRequests } from "./step-features";
import { collectGrants } from "./define-step";
import {
  createCodeStepWorkItemsClient,
  grantsHaveWorkItemsClient,
  type HasWorkItemsClient,
  type WorkItemsClient,
} from "./code-step-work-items-client";
import {
  assertBaseBranchFitsEnvironment,
  compileRepo,
  type RepoField,
  type RepoSpec,
} from "./repo";
import { isEnvironmentHandle } from "../../push/code-step-lookup";
import { assertNoConnectorMcpCollisions, mergeStepMcps } from "./compile-mcps";
import type { McpHandle } from "./define-mcp";
import {
  createCodeStepMcpClient,
  type McpClients,
} from "./code-step-mcp-client";
import type { StepErrorOptions } from "./step-error";

/** A code step's `mcps`: `defineMcp` handles keyed by the step's server key. */
export type CodeStepMcps = Record<string, McpHandle>;

/**
 * Fails the step with a pipeline error name: a built-in one or one the step
 * declares in `errors`. The Task fails with that name, so a pipeline's
 * `retry` and `catch` can match it.
 */
export type CodeStepFail<TErrors extends string = never> = (
  name: BuiltInError | TErrors,
  message: string,
  options?: StepErrorOptions,
) => never;

/**
 * What a code step's `fn` gets besides its input. `mcp` is present only when
 * the step declares `mcps`: one client per server key. `workItems` is present
 * only when its features grant `read`, `create` or `update` on `project`, with
 * the methods those grants allow.
 */
export type CodeStepContext<
  TMcps extends CodeStepMcps = Record<never, never>,
  TErrors extends string = never,
  TGrants extends Grant = never,
> = {
  /**
   * Absolute path of the step-artifacts folder, which already exists. Write
   * a file here and return its path relative to this folder with
   * `Artifact.path(...)` to fill an artifact field.
   */
  artifactsDir: string;
  /**
   * Throws a `StepError` whose name the worker reports as the Task's error.
   * Only built-in names and the step's `errors` type-check here; a bare
   * `throw new StepError(...)` works too, and the worker reports any other
   * name as `Scarn.StepFailed`. In a unit test, pass `failStep`.
   */
  fail: CodeStepFail<TErrors>;
} & ([keyof TMcps] extends [never] ? unknown : { mcp: McpClients<TMcps> }) &
  (HasWorkItemsClient<TGrants> extends true
    ? { workItems: WorkItemsClient<TGrants> }
    : unknown);

export type CodeStepFn<
  TInput,
  TResult,
  TMcps extends CodeStepMcps = Record<never, never>,
  TErrors extends string = never,
  TGrants extends Grant = never,
> = (
  input: TInput,
  context: CodeStepContext<TMcps, TErrors, TGrants>,
) => TResult | Promise<TResult>;

export type DefineCodeStepInput<
  TInput extends ZodType = ZodType,
  TResult extends ZodType = ZodType,
  TFeatures extends ReadonlyArray<CodeStepFeature> = never[],
  TEnv extends EnvRecord = EnvRecord,
  TNamed extends NamedStepEnvironment | undefined =
    NamedStepEnvironment | undefined,
  TMcps extends CodeStepMcps = Record<never, never>,
  TErrors extends string = never,
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
   *
   * With `mcps`, the context also carries `mcp`, whose clients call the
   * servers' tools through the worker during a run. In a unit test, pass
   * `createFakeMcpClients(...)` as `mcp` instead.
   *
   * `context.fail(name, message)` fails the step with a named error.
   *
   * With `Features.workItems.*` grants on `project`, the context also carries
   * `workItems`. In a unit test, pass `createFakeWorkItems(features)`.
   */
  fn: CodeStepFn<
    TInput["_output"],
    EffectiveResult<TResult["_output"], TFeatures>,
    TMcps,
    NoInfer<TErrors>,
    FeatureGrants<TFeatures>
  >;
  inputSchema?: TInput;
  resultSchema?: TResult;
  /**
   * The MCP servers `fn` calls, built with `defineMcp` (add a catalog with
   * `withTools` for typed methods) and keyed by the step's server key. Each
   * server's health checks run before `fn`. A key may not reuse a connector
   * id of the step's environment.
   */
  mcps?: TMcps;
  /**
   * Step features to attach — unlike `defineStep()`, only each feature's
   * `_resultExtension` applies here (there is no prompt to append
   * to on a `kind: "code"` step). `Features.workItems.read`, `create` and
   * `update` on `project` give `fn` a `context.workItems`; any other work item
   * feature is a type error and throws, since a code step has no agent tools
   * to use it with.
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
  errors?: readonly TErrors[];
  /** As `defineStep()`'s `retry`: how a standalone Task of this step retries. */
  retry?: readonly StepRetryEntry[];
  /** As `defineStep()`'s `concurrency`: the per-work-item concurrency limit. */
  concurrency?: StepConcurrency;
  /**
   * When the step's run logs are archived. `{ archive: "on-failure" }` skips
   * the log of a succeeded run that no person started, such as a scheduled
   * sync, so it doesn't count toward log storage. Failed runs and Run now
   * always keep theirs. Omitted means `{ archive: "always" }`.
   */
  logs?: StepLogs;
};

type EntrypointFn = NonNullable<StepDefinitionSpec["entrypoint"]>["fn"];

/**
 * The function the worker runs. With `mcps` it wraps `fn` to add `mcp` to the
 * worker's context, and with work item grants on `project` to add
 * `workItems`; the clients read the bridge env on their first call, so the
 * runner script stays unaware of them. Otherwise it is `fn` itself. The
 * runner supplies `artifactsDir` and `fail`.
 */
function entrypointFn(
  fn: (input: never, context: never) => unknown,
  mcps: CodeStepMcps | undefined,
  grants: readonly Grant[],
): EntrypointFn {
  const run = fn as unknown as EntrypointFn;
  const extras: Record<string, unknown> = {};
  if (mcps !== undefined && Object.keys(mcps).length > 0) {
    extras["mcp"] = createCodeStepMcpClient(mcps);
  }
  if (grantsHaveWorkItemsClient(grants)) {
    extras["workItems"] = createCodeStepWorkItemsClient(grants);
  }
  if (Object.keys(extras).length === 0) return run;
  return (input, context) => run(input, { ...context, ...extras });
}

/** Throws for a work item grant a code step may not hold. */
function assertCodeStepGrants(stepKey: string, grants: readonly Grant[]): void {
  for (const grant of grants) {
    if (grant.scope === "project") continue;
    throw new Error(
      `Step "${stepKey}": a code step may only use Features.workItems.read, create and update with scope "project", not ${grant.action} on "${grant.scope}". It has no agent tools to use other grants with.`,
    );
  }
}

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
  TMcps extends CodeStepMcps = Record<never, never>,
>(
  config: Omit<
    DefineCodeStepInput<
      TInput,
      TResult,
      TFeatures,
      TEnv,
      TNamed,
      TMcps,
      TErrors
    >,
    "retry"
  > & {
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
  if (hasGrantRequests(features)) {
    throw new Error(
      `Step "${config.key}": Features.grantRequests() is for agent steps only. A code step has no agent to ask for grants; attach the grants it needs with Features.workItems.* instead.`,
    );
  }
  const grants = collectGrants(config.key, features);
  assertCodeStepGrants(config.key, grants);

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
  assertNoConnectorMcpCollisions(config.key, config.environment, config.mcps);
  const mcpFields = mergeStepMcps(config.key, {
    mcps: config.mcps,
    healthChecks: null,
    envJson: null,
  });

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
    opencodeMcpJson: mcpFields.opencodeMcpJson,
    healthChecksJson: mcpFields.healthChecksJson,
    ...(repo !== undefined ? { repo } : {}),
    errors: compileStepErrors(config.key, config.errors),
    retryJson: compileStepRetry(config.key, config.retry, config.errors ?? []),
    ...(config.concurrency !== undefined
      ? {
          concurrency: compileStepConcurrency(config.key, config.concurrency),
        }
      : {}),
    ...compileStepLogs(config.key, config.logs),
    ...(grants.length > 0 ? { grants } : {}),
    entrypoint: { fn: entrypointFn(config.fn, config.mcps, grants) },
  };

  return toStepHandle(spec, environmentHandle) as StepHandle<
    TInput["_output"],
    EffectiveResult<TResult["_output"], TFeatures>,
    TErrors
  >;
}
