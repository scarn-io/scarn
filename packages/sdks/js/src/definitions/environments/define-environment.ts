/**
 * `defineEnvironment`: a named environment written in TypeScript next to the
 * steps that use it. It compiles to the environment content the server stores
 * (`PUT /projects/:projectId/environments/:name`), and steps take the handle
 * in place of the name.
 */
import { containsInputToken, type EnvVarsInput } from "../../env-vars";
import { findMissingConnectorVars } from "../../connectors";
import {
  environmentContentSchema,
  environmentNameSchema,
  type EnvironmentContentOutput,
} from "../../environment";
import { normalizeEnv, type EnvRecord } from "../steps/env";
import {
  assertNoSetupVarsOnHost,
  compileConnectors,
  type RuntimeSpec,
} from "../steps/runtime";

export type DefineEnvironmentInput<TEnv extends EnvRecord = EnvRecord> = {
  /** The name steps use to refer to it: `[a-z0-9][a-z0-9-]*`. */
  name: string;
  description?: string;
  /** Defaults to the repository's runtime. */
  runtime?: RuntimeSpec;
  /**
   * A record only: an environment is shared by steps with different inputs,
   * so it has no function form and no `{{input.…}}` tokens.
   */
  vars?: TEnv;
  /**
   * Scarn catalog connectors to turn on, e.g. `["datadog"]`. `vars` must
   * provide each connector's required variables.
   */
  connectors?: readonly string[];
};

/** A named environment's compiled content: what push uploads. */
export type EnvironmentContent = EnvironmentContentOutput;

/**
 * What `defineEnvironment` returns. A step can use it in place of the
 * environment's name. `__env` is a phantom field: it exists only in the type,
 * so a step's prompt `env` can be typed from the environment's `vars`.
 */
export type EnvironmentHandle<TEnv extends EnvRecord = EnvRecord> = {
  readonly kind: "environment";
  readonly name: string;
  readonly content: EnvironmentContent;
  readonly __env: TEnv;
};

function compileContent(
  owner: string,
  config: DefineEnvironmentInput,
): EnvironmentContent {
  if (typeof config.vars === "function") {
    throw new Error(
      `${owner}: vars must be a record; an environment is shared across steps with different inputs, so it has no function form.`,
    );
  }
  const vars = normalizeEnv(config.vars);
  const tokenVar = (vars ?? []).find((entry) =>
    [
      entry.source === "value" ? entry.value : undefined,
      entry.source === "inherit" ? entry.default : undefined,
    ].some((value) => value !== undefined && containsInputToken(value)),
  );
  if (tokenVar !== undefined) {
    throw new Error(
      `${owner} env "${tokenVar.name}": an environment is shared across steps with different inputs, so it cannot use {{input.…}} tokens. Put input-dependent vars on the step's inline environment.`,
    );
  }
  assertNoSetupVarsOnHost(vars, config.runtime, owner);
  const connectors = compileConnectors(config.connectors, owner);
  assertConnectorVars(owner, connectors ?? [], vars ?? []);
  const parsed = environmentContentSchema.safeParse({
    ...(config.description === undefined
      ? {}
      : { description: config.description }),
    ...(config.runtime === undefined ? {} : { runtime: config.runtime }),
    ...(vars === null ? {} : { vars }),
    ...(connectors === undefined ? {} : { connectors }),
  });
  if (parsed.success) return parsed.data;
  throw new Error(
    `${owner}: ${parsed.error.issues
      .map((issue) =>
        issue.path.length > 0
          ? `${issue.path.map(String).join(".")}: ${issue.message}`
          : issue.message,
      )
      .join("; ")}`,
  );
}

function assertConnectorVars(
  owner: string,
  connectors: readonly string[],
  vars: EnvVarsInput,
): void {
  const missing = findMissingConnectorVars(connectors, vars);
  if (missing.length === 0) return;
  throw new Error(
    `${owner} is missing variables its connectors need: ${missing
      .map(({ connector, vars }) => `${connector} needs ${vars.join(", ")}`)
      .join("; ")}. Add them to the environment's vars.`,
  );
}

/**
 * Defines a named environment. Runs the checks inline environments run (no
 * static secrets, no setup vars on host, known connectors) plus every
 * connector's required vars, and throws on the first problem.
 */
export function defineEnvironment<
  const TEnv extends EnvRecord = Record<never, never>,
>(config: DefineEnvironmentInput<TEnv>): EnvironmentHandle<TEnv> {
  const owner = `Environment "${config.name}"`;
  const name = environmentNameSchema.safeParse(config.name);
  if (!name.success) {
    throw new Error(
      `${owner}: name ${name.error.issues.map((issue) => issue.message).join("; ")}`,
    );
  }
  if ("branch" in config) {
    throw new Error(
      `${owner}: environments have no branch; use the step's repo baseBranch.`,
    );
  }
  let content: EnvironmentContent;
  try {
    content = compileContent(owner, config);
  } catch (error) {
    if (error instanceof Error && !error.message.startsWith(owner)) {
      throw new Error(`${owner}: ${error.message}`, { cause: error });
    }
    throw error;
  }
  return Object.freeze({
    kind: "environment",
    name: name.data,
    content,
  }) as EnvironmentHandle<TEnv>;
}
