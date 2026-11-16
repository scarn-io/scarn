import type { EnvVarsInput } from "../../env-vars";
import { environmentNameSchema } from "../../environment";
import { devcontainerConfigPathSchema } from "../../devcontainer-config-path";
import {
  MANAGED_RUNTIME_IDS,
  type ManagedRuntimeId,
} from "../../managed-runtimes";
import { connectorIdsSchema } from "../../connectors";
import { normalizeEnv, type EnvFn, type EnvRecord } from "./env";
import type { CompileRepoContext } from "./repo";
import type { EnvironmentHandle } from "../environments/define-environment";
import { isEnvironmentHandle } from "../../push/code-step-lookup";

/**
 * Authoring helpers for a step's `environment` option, and the definition-time
 * compilation that turns it into a named or inline environment reference.
 */

/** Where a step runs. Build one with `Runtime.devcontainer()`, `Runtime.host()` or `Runtime.managed.<id>()`. */
export type DevcontainerRuntimeSpec = {
  readonly kind: "devcontainer";
  readonly config?: string;
};

export type HostRuntimeSpec = { readonly kind: "host" };

/**
 * A worker-supplied container (image and config owned by the worker). Build one
 * with `Runtime.managed.<id>()`. Works with `codeStep` and `defineStep`.
 */
export type ManagedRuntimeSpec<
  TId extends ManagedRuntimeId = ManagedRuntimeId,
> = {
  readonly kind: "managed";
  readonly id: TId;
};

export type RuntimeSpec =
  DevcontainerRuntimeSpec | HostRuntimeSpec | ManagedRuntimeSpec;

/**
 * A named environment, by name or by `defineEnvironment` handle, or an inline
 * runtime, vars and connectors.
 *
 * For inline environments, declare `vars` before `agentPrompt` so `TEnv` is
 * inferred into the prompt's `env`: only declared, non-secret keys. A handle
 * types the prompt's `env` from its own `vars` the same way.
 */
export type StepEnvironment<TInput, TEnv extends EnvRecord = EnvRecord> =
  string | EnvironmentHandle<TEnv> | InlineStepEnvironment<TInput, TEnv>;

/** A named environment: its name, or its `defineEnvironment` handle. */
export type NamedStepEnvironment = string | EnvironmentHandle;

export type InlineStepEnvironment<
  TInput,
  TEnv extends EnvRecord = EnvRecord,
> = {
  /** Defaults to the repository's runtime. */
  runtime?: RuntimeSpec;
  vars?: EnvFn<TInput, TEnv> | TEnv;
  /**
   * Scarn catalog connectors to turn on, e.g. `["datadog"]`. `vars` must
   * provide each connector's required variables.
   */
  connectors?: readonly string[];
};

/**
 * `codeStep`'s environment: `StepEnvironment`'s workspace variant. A code step
 * currently requires a devcontainer or managed runtime.
 */
export type CodeStepEnvironment<TInput, TEnv extends EnvRecord = EnvRecord> =
  NamedStepEnvironment | InlineCodeStepEnvironment<TInput, TEnv>;

/** `codeStep`'s inline environment. */
export type InlineCodeStepEnvironment<
  TInput,
  TEnv extends EnvRecord = EnvRecord,
> = {
  /**
   * Defaults to `Runtime.managed.bun1()`. `Runtime.devcontainer()` opts into the
   * project's own container. `Runtime.host()` is not supported.
   */
  runtime?: DevcontainerRuntimeSpec | ManagedRuntimeSpec;
  vars?: EnvFn<TInput, TEnv> | TEnv;
};

export type DevcontainerRuntimeOpts = {
  /**
   * Full repo-relative path to the devcontainer config, e.g.
   * `.devcontainer/frontend/devcontainer.json`. The basename must be
   * `devcontainer.json` or `.devcontainer.json`. There is no fallback: if the
   * file is missing on the step's base branch, the step fails.
   */
  readonly config?: string;
};

export type ManagedRuntimeFactories = {
  readonly [K in ManagedRuntimeId]: () => ManagedRuntimeSpec<K>;
};

const managedRuntimeFactories = Object.fromEntries(
  MANAGED_RUNTIME_IDS.map((id) => [id, () => ({ kind: "managed", id })]),
) as ManagedRuntimeFactories;

export const Runtime = {
  /**
   * Worker-supplied containers, one factory per identifier, for example
   * `Runtime.managed.bun1()`. The worker owns the image and clones the repo
   * into it; the repo holds nothing. For a `codeStep` it also installs the
   * pipeline-builder dependencies. An unknown identifier is a type error.
   */
  managed: managedRuntimeFactories,

  /**
   * Runs the step in the repository's devcontainer. Without `config` the worker
   * searches for `.devcontainer/devcontainer.json`, then `devcontainer.json`.
   * Throws when `config` breaks the path rules.
   */
  devcontainer(opts?: DevcontainerRuntimeOpts): DevcontainerRuntimeSpec {
    if (opts?.config === undefined) return { kind: "devcontainer" };
    const parsed = devcontainerConfigPathSchema.safeParse(opts.config);
    if (!parsed.success) {
      throw new Error(
        `Runtime.devcontainer config "${opts.config}": ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
      );
    }
    return { kind: "devcontainer", config: parsed.data };
  },

  /**
   * Runs the step on the worker host, without a container. Takes no
   * options, so a config path cannot be combined with it. Not supported for
   * `codeStep`, which needs a container.
   */
  host(): HostRuntimeSpec {
    return { kind: "host" };
  },
} as const;

export type CompiledInlineEnvironment = {
  kind: "inline";
  runtime?: RuntimeSpec;
  envJson: EnvVarsInput | null;
  connectors?: string[];
};

export type CompiledEnvironment =
  CompiledInlineEnvironment | { kind: "named"; name: string } | null;

export type CompileEnvironmentContext = CompileRepoContext & {
  /** Used when the environment declares no `runtime`. `codeStep` passes the default managed runtime. */
  readonly defaultRuntime?: ManagedRuntimeSpec;
};

/**
 * A host step has no container, so nothing runs `devcontainer up`. `owner`
 * prefixes the error, e.g. `Step "fix-bug"` or `Environment "frontend"`.
 */
export function assertNoSetupVarsOnHost(
  envJson: EnvVarsInput | null,
  runtime: RuntimeSpec | undefined,
  owner: string | undefined,
): void {
  if (runtime?.kind !== "host") return;
  const setupVar = (envJson ?? []).find(
    (entry) => (entry.applies ?? "agent") !== "agent",
  );
  if (!setupVar) return;
  throw new Error(
    `${owner ? `${owner} ` : ""}env "${setupVar.name}": applies "${String(setupVar.applies)}" needs a container to set up, but Runtime.host() has none. Use applies "agent" or Runtime.devcontainer().`,
  );
}

/** Checks connector ids against the catalog. `owner` prefixes the error. */
export function compileConnectors(
  connectors: readonly string[] | undefined,
  owner: string | undefined,
): string[] | undefined {
  if (connectors === undefined || connectors.length === 0) return undefined;
  const parsed = connectorIdsSchema.safeParse([...connectors]);
  if (!parsed.success) {
    throw new Error(
      `${owner ? `${owner} ` : ""}environment connectors: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
    );
  }
  return parsed.data;
}

function stepOwner(stepKey: string | undefined): string | undefined {
  return stepKey === undefined ? undefined : `Step "${stepKey}"`;
}

/**
 * The vars a step's environment declares, as definition time knows them: a
 * handle's content vars, or the compiled inline vars (none when the step has
 * no environment). `undefined` for an environment named by string, which the
 * server checks at publish.
 */
export function knownEnvironmentVars<TInput, TEnv extends EnvRecord>(
  environment:
    StepEnvironment<TInput, TEnv> | CodeStepEnvironment<TInput> | undefined,
  compiled: CompiledEnvironment,
): EnvVarsInput | undefined {
  if (isEnvironmentHandle(environment)) return environment.content.vars ?? [];
  if (compiled?.kind === "named") return undefined;
  return compiled?.envJson ?? [];
}

/**
 * Turns the authored `environment` into a reference. Named environments are
 * resolved by the worker; inline environments run `vars` once and reject static
 * secrets and setup variables on the host runtime.
 */
export function compileEnvironment<TInput, TEnv extends EnvRecord>(
  environment:
    | InlineStepEnvironment<TInput, TEnv>
    | Exclude<CodeStepEnvironment<TInput>, string | EnvironmentHandle>
    | undefined,
  ctx?: CompileEnvironmentContext,
): CompiledInlineEnvironment | null;
export function compileEnvironment<TInput, TEnv extends EnvRecord>(
  environment:
    StepEnvironment<TInput, TEnv> | CodeStepEnvironment<TInput> | undefined,
  ctx?: CompileEnvironmentContext,
): CompiledEnvironment;
export function compileEnvironment<TInput, TEnv extends EnvRecord>(
  environment:
    StepEnvironment<TInput, TEnv> | CodeStepEnvironment<TInput> | undefined,
  ctx: CompileEnvironmentContext = {},
): CompiledEnvironment {
  if (typeof environment === "string") {
    return { kind: "named", name: environmentNameSchema.parse(environment) };
  }
  if (isEnvironmentHandle(environment)) {
    return { kind: "named", name: environment.name };
  }
  if (environment === undefined && ctx.defaultRuntime === undefined)
    return null;
  if (environment !== undefined && "branch" in environment) {
    throw new Error(
      `${stepOwner(ctx.stepKey) ?? "Inline environment"}: environments have no branch; use the step's repo baseBranch.`,
    );
  }
  const runtime: RuntimeSpec | undefined =
    environment?.runtime ?? ctx.defaultRuntime;
  const envJson = normalizeEnv(environment?.vars);
  assertNoSetupVarsOnHost(envJson, runtime, stepOwner(ctx.stepKey));
  const connectors = compileConnectors(
    environment !== undefined && "connectors" in environment
      ? environment.connectors
      : undefined,
    stepOwner(ctx.stepKey),
  );
  return {
    kind: "inline",
    ...(runtime === undefined ? {} : { runtime }),
    envJson,
    ...(connectors === undefined ? {} : { connectors }),
  };
}
