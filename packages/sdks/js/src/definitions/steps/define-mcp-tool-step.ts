/**
 * MCP tool steps (ADR 0014): `kind: "mcp_tool"` steps that call one tool on
 * one MCP server, with no LLM. A tool reference is one catalog entry bound to
 * a `defineMcp` handle by `.withTools(catalog)`; `toolRef.step(options?)`
 * builds the step.
 *
 * Without `args`, the step passes its input straight to the tool, so its
 * input schema is the tool's. With `args`, the step declares its own
 * `inputSchema` and `args` maps it onto the tool's arguments as an args
 * template. The result is the tool's `structuredContent` when the catalog
 * declares an output schema, else the MCP content result.
 */
import type { ZodType } from "zod";
import { toJSONSchema, type $ZodType } from "zod/v4/core";
import { MCP_TOOL_CONTENT_RESULT_SCHEMA } from "../../contracts/pipeline-document/built-ins";
import type { JsonSchema } from "../../contracts/pipeline-document/json";
import { NODE_ID_PATTERN } from "../../contracts/pipeline-document/schema";
import { AuthoringError } from "../../pipelines/errors";
import type { BuiltInError, McpToolContentResult } from "../../pipelines/types";
import { isEnvironmentHandle } from "../../push/code-step-lookup";
import type { McpTool } from "../mcp-tools/catalog";
import {
  assertArgsTemplateFitsEnvironment,
  compileArgsTemplate,
  type ArgsTemplate,
  type ArgsTemplateContext,
} from "./args-template";
import { assertNoConnectorMcpCollisions, compileMcps } from "./compile-mcps";
import { resolveMcpChecks, type McpHandle } from "./define-mcp";
import type { StepConcurrency, StepDefinitionSpec } from "./define-step";
import type { EnvRecord, PromptEnvContext } from "./env";
import { hasGrantRequests, type AnyStepFeature } from "./step-features";
import {
  assertBaseBranchFitsEnvironment,
  compileRepo,
  type RepoField,
  type RepoSpec,
} from "./repo";
import {
  compileEnvironment,
  knownEnvironmentVars,
  Runtime,
  type DevcontainerRuntimeSpec,
  type InlineStepEnvironment,
  type ManagedRuntimeSpec,
  type NamedStepEnvironment,
} from "./runtime";
import {
  compileStepConcurrency,
  compileStepErrors,
  compileStepRetry,
  toStepHandle,
  type StepHandle,
} from "./step-handle";

/** The longest default key `<server>-<tool>` may produce. */
export const MCP_TOOL_STEP_DEFAULT_KEY_MAX_LENGTH = 64;

/** The args template of a pass-through step: the whole step input. */
const PASS_THROUGH_ARGS_TEMPLATE = "{{input}}";

/** What a tool step returns: the tool's output, or the MCP content result. */
export type McpToolStepResult<TTool extends McpTool> = [
  TTool["output"],
] extends [ZodType]
  ? Extract<TTool["output"], ZodType>["_output"]
  : McpToolContentResult;

/** The tool's arguments, as `args` must return them. */
export type McpToolArgs<TTool extends McpTool> = TTool["input"]["_input"];

type McpToolStepCommonOptions<
  TStepInput,
  TResult,
  TErrors extends string,
  TEnv extends EnvRecord,
  TNamed extends NamedStepEnvironment | undefined,
> = {
  /** Defaults to `<server>-<tool>` in kebab case, from the handle's name and the tool's name. */
  key?: string;
  /** Defaults to the tool's title, else the step key. */
  name?: string;
  /** Defaults to the tool's description. */
  description?: string | null;
  version?: number;
  /**
   * A named environment, or an inline runtime and vars. With no `runtime`, a
   * `local` (stdio) server runs in `Runtime.devcontainer()`; a `remote`
   * server or one with a managed connection runs in
   * `Runtime.managed.bun1()`; any other `ref` runs in the devcontainer.
   */
  environment?: InlineStepEnvironment<TStepInput, TEnv> | TNamed;
  repo?: RepoField<
    TStepInput,
    TResult,
    RepoSpec,
    PromptEnvContext<TEnv, TNamed>
  >;
  status?: "draft" | "active";
  /** As `codeStep()`'s `errors`. */
  errors?: readonly TErrors[];
  /** As `codeStep()`'s `retry`. */
  retry?: readonly {
    on: readonly (BuiltInError | TErrors)[];
    maxAttempts: number;
  }[];
  /** As `codeStep()`'s `concurrency`. */
  concurrency?: StepConcurrency;
};

/** A pass-through step: its input is the tool's arguments. */
export type McpToolPassThroughStepOptions<
  TTool extends McpTool,
  TErrors extends string,
  TEnv extends EnvRecord,
  TNamed extends NamedStepEnvironment | undefined,
> = McpToolStepCommonOptions<
  TTool["input"]["_output"],
  McpToolStepResult<TTool>,
  TErrors,
  TEnv,
  TNamed
> & {
  inputSchema?: undefined;
  args?: undefined;
};

/** An adapted step: its own input, mapped onto the tool's arguments by `args`. */
export type McpToolAdaptedStepOptions<
  TTool extends McpTool,
  TInput extends ZodType,
  TErrors extends string,
  TEnv extends EnvRecord,
  TNamed extends NamedStepEnvironment | undefined,
> = McpToolStepCommonOptions<
  TInput["_output"],
  McpToolStepResult<TTool>,
  TErrors,
  TEnv,
  TNamed
> & {
  /** The step's own input; `z.object({})` when it takes none. */
  inputSchema: TInput;
  /**
   * Builds the tool's arguments. It runs once, at define time, against token
   * proxies for `input` and the environment's non-secret `env`, so it may
   * place values but not transform them.
   */
  args: (
    context: ArgsTemplateContext<
      TInput["_output"],
      PromptEnvContext<TEnv, TNamed>
    >,
  ) => McpToolArgs<TTool>;
};

/** One catalog entry bound to a `defineMcp` handle. */
export interface McpToolRef<TTool extends McpTool = McpTool> {
  readonly kind: "mcpToolRef";
  /** The tool's key in the catalog. */
  readonly catalogKey: string;
  readonly tool: TTool;
  readonly handle: McpHandle;
  step<
    const TErrors extends string = never,
    TEnv extends EnvRecord = EnvRecord,
    TNamed extends NamedStepEnvironment | undefined = undefined,
  >(
    options?: McpToolPassThroughStepOptions<TTool, TErrors, TEnv, TNamed>,
  ): StepHandle<TTool["input"]["_output"], McpToolStepResult<TTool>, TErrors>;
  step<
    TInput extends ZodType,
    const TErrors extends string = never,
    TEnv extends EnvRecord = EnvRecord,
    TNamed extends NamedStepEnvironment | undefined = undefined,
  >(
    options: McpToolAdaptedStepOptions<TTool, TInput, TErrors, TEnv, TNamed>,
  ): StepHandle<TInput["_output"], McpToolStepResult<TTool>, TErrors>;
}

/** The `tools` record of a handle with a catalog. */
export type McpToolRefs<TTools extends Record<string, McpTool>> = {
  readonly [K in keyof TTools]: McpToolRef<TTools[K]>;
};

type AnyMcpToolStepOptions = McpToolStepCommonOptions<
  unknown,
  unknown,
  string,
  EnvRecord,
  NamedStepEnvironment | undefined
> & {
  inputSchema?: ZodType;
  args?: (context: ArgsTemplateContext<unknown, unknown>) => unknown;
};

export function createMcpToolRef<TTool extends McpTool>(
  handle: McpHandle,
  catalogKey: string,
  tool: TTool,
): McpToolRef<TTool> {
  const ref = {
    kind: "mcpToolRef",
    catalogKey,
    tool,
    handle,
    step: (options: AnyMcpToolStepOptions = {}) =>
      defineMcpToolStep(handle, tool, options),
  };
  return Object.freeze(ref) as unknown as McpToolRef<TTool>;
}

function toKebabCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * `<server>-<tool>` in kebab case. Throws when the result is still not a
 * valid step key or is longer than `MCP_TOOL_STEP_DEFAULT_KEY_MAX_LENGTH`.
 */
export function defaultMcpToolStepKey(server: string, tool: string): string {
  const key = toKebabCase(`${server}-${tool}`);
  const ask = `Pass one with .step({ key: "…" }).`;
  if (!NODE_ID_PATTERN.test(key)) {
    throw new AuthoringError(
      `MCP tool step for "${server}" tool "${tool}": the default key "${key}" is not a valid step key. ${ask}`,
    );
  }
  if (key.length > MCP_TOOL_STEP_DEFAULT_KEY_MAX_LENGTH) {
    throw new AuthoringError(
      `MCP tool step for "${server}" tool "${tool}": the default key "${key}" is longer than ${String(MCP_TOOL_STEP_DEFAULT_KEY_MAX_LENGTH)} characters. ${ask}`,
    );
  }
  return key;
}

/**
 * The runtime a tool step gets when its environment names none: the
 * devcontainer for a stdio server (it needs the server's toolchain), the
 * managed Bun container for a remote or managed-connection server, and the
 * devcontainer for a `ref` whose transport isn't known at define time.
 */
export function defaultMcpToolStepRuntime(
  handle: McpHandle,
): ManagedRuntimeSpec | DevcontainerRuntimeSpec {
  switch (handle.type) {
    case "local":
      return Runtime.devcontainer();
    case "remote":
      return Runtime.managed.bun1();
    case "ref":
      return handle.server.auth !== undefined
        ? Runtime.managed.bun1()
        : Runtime.devcontainer();
  }
}

function assertNoHealthChecks(stepKey: string, handle: McpHandle): void {
  const enabled = resolveMcpChecks(handle).filter((check) => check.enabled);
  if (enabled.length === 0) return;
  throw new AuthoringError(
    `Step "${stepKey}": MCP tool steps run no health checks (connecting is the check), but MCP server "${handle.name}" has ${enabled.map((check) => `"${check.name}"`).join(", ")}. Call .disableAllChecks() on the handle before .withTools().`,
  );
}

function assertSchemaOptions(
  stepKey: string,
  options: AnyMcpToolStepOptions,
): void {
  if (options.args === undefined && options.inputSchema !== undefined) {
    throw new AuthoringError(
      `Step "${stepKey}": inputSchema needs args. Without args the step's input is the tool's arguments, so its schema is the tool's; add args to map your own input onto them.`,
    );
  }
  if (options.args !== undefined && options.inputSchema === undefined) {
    throw new AuthoringError(
      `Step "${stepKey}": args needs an inputSchema for the step's own input (z.object({}) if it takes none).`,
    );
  }
}

/** Rejects `Features.grantRequests()` for JS callers the types don't reach. */
function assertNoGrantRequests(
  stepKey: string,
  options: AnyMcpToolStepOptions,
): void {
  const features: unknown = (options as { features?: unknown }).features;
  if (!Array.isArray(features)) return;
  if (!hasGrantRequests(features as AnyStepFeature[])) return;
  throw new AuthoringError(
    `Step "${stepKey}": Features.grantRequests() is for agent steps only. An MCP tool step calls one tool and has no agent to ask for grants.`,
  );
}

function schemaObject(
  stepKey: string,
  which: "input" | "output",
  schema: JsonSchema,
): Record<string, unknown> {
  if (typeof schema !== "object") {
    throw new AuthoringError(
      `Step "${stepKey}": the tool's ${which} schema must be a JSON Schema object, not ${String(schema)}.`,
    );
  }
  return structuredClone(schema);
}

function defineMcpToolStep(
  handle: McpHandle,
  tool: McpTool,
  options: AnyMcpToolStepOptions,
): StepHandle {
  const key = options.key ?? defaultMcpToolStepKey(handle.name, tool.name);
  assertSchemaOptions(key, options);
  assertNoGrantRequests(key, options);
  assertNoHealthChecks(key, handle);

  const environmentHandle = isEnvironmentHandle(options.environment)
    ? options.environment
    : undefined;
  const environment = compileEnvironment(options.environment, {
    stepKey: key,
    defaultRuntime: defaultMcpToolStepRuntime(handle),
  });
  const knownVars = knownEnvironmentVars(options.environment, environment);
  const repo = compileRepo(options.repo, { stepKey: key });
  assertBaseBranchFitsEnvironment(repo, knownVars, { stepKey: key });

  const argsTemplate: ArgsTemplate =
    options.args === undefined
      ? PASS_THROUGH_ARGS_TEMPLATE
      : compileArgsTemplate(options.args, { stepKey: key });
  assertArgsTemplateFitsEnvironment(argsTemplate, knownVars, { stepKey: key });

  const mcps = { [handle.name]: handle };
  assertNoConnectorMcpCollisions(key, options.environment, mcps);
  const compiled = compileMcps(mcps, key);

  const spec: StepDefinitionSpec = {
    key,
    name: options.name ?? tool.title ?? key,
    description: options.description ?? tool.description,
    version: options.version ?? 1,
    kind: "mcp_tool",
    status: options.status ?? "active",
    environment,
    prompt: null,
    inputSchemaJson:
      options.inputSchema === undefined
        ? schemaObject(key, "input", tool.inputJsonSchema)
        : toJSONSchema(options.inputSchema as unknown as $ZodType),
    resultSchemaJson: schemaObject(
      key,
      "output",
      tool.outputJsonSchema ?? MCP_TOOL_CONTENT_RESULT_SCHEMA,
    ),
    opencodeMcpJson: compiled.opencodeMcpJson,
    healthChecksJson: null,
    ...(repo !== undefined ? { repo } : {}),
    errors: compileStepErrors(key, options.errors),
    retryJson: compileStepRetry(key, options.retry, options.errors ?? []),
    ...(options.concurrency !== undefined
      ? { concurrency: compileStepConcurrency(key, options.concurrency) }
      : {}),
    toolCall: {
      server: handle.name,
      tool: tool.name,
      argsTemplate,
      toolSchemas: {
        input: structuredClone(tool.inputJsonSchema),
        output:
          tool.outputJsonSchema === null
            ? null
            : structuredClone(tool.outputJsonSchema),
      },
    },
  };
  return toStepHandle(spec, environmentHandle);
}
