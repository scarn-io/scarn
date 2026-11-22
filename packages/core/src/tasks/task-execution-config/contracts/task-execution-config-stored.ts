import {
  storedEnvironmentFieldsSchema,
  type storedEnvironmentRuntimeSchema,
} from "@scarn/core/common/contracts/environment";
import { storedEnvVarsSchema } from "@scarn/core/common/contracts/env-vars";
import { healthChecksSchema } from "@scarn/core/common/contracts/health-checks";
import { managedRuntimeIdSchema } from "@scarn/core/common/contracts/managed-runtime";
import { resolveRepoConfig } from "@scarn/core/common/contracts/repo-config";
import { storedOpenCodeMcpServersSchema } from "@scarn/core/common/contracts/stored-opencode-mcp";
import { repoBaseBranchSchema } from "@scarn/sdk/repo-config";
import { z } from "zod";

/**
 * Read-side schemas for `task_execution_configs` rows, one per
 * `schema_version` (D6). Structural only: unknown keys are stripped and
 * write-time rules (path rules, secret rules, cross-field rules) are not
 * re-applied, so tightening a write rule never makes a stored row
 * unreadable. A breaking change to the stored shape adds a new version, a
 * stored schema for it, a `vN → vN+1` converter and a fixture under
 * `tests/tasks/task-execution-config/fixtures/`.
 */

const storedRuntimeV1Schema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("devcontainer"),
    configPath: z.string().optional(),
  }),
  z.object({ type: z.literal("managed"), id: managedRuntimeIdSchema }),
  z.object({ type: z.literal("none") }),
]);

const storedEnvV1Schema = storedEnvVarsSchema;

/** `gitCredentials` was added to v1 additively; a row without it reads as the default, `"auto"`. */
const storedGitCredentialsV1Schema = z.enum(["auto", "none"]).default("auto");

const storedGitV1Schema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("none") }),
  z.object({
    mode: z.literal("readOnly"),
    gitCredentials: storedGitCredentialsV1Schema,
  }),
  z.object({
    mode: z.literal("readWrite"),
    message: z.string().nullable(),
    onPushFailure: z.enum(["fail", "warn"]),
    gitCredentials: storedGitCredentialsV1Schema,
  }),
]);

export const storedTaskExecutionConfigV1Schema = z.object({
  runtime: storedRuntimeV1Schema.nullable(),
  env: storedEnvV1Schema.nullable(),
  git: storedGitV1Schema.nullable(),
  mcp: storedOpenCodeMcpServersSchema.nullable(),
  healthChecks: healthChecksSchema.nullable(),
});

export type TaskExecutionConfigContentV1 = z.output<
  typeof storedTaskExecutionConfigV1Schema
>;

const storedRuntimeV2Schema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("devcontainer"),
    configPath: z.string().optional(),
  }),
  z.object({ type: z.literal("managed"), id: managedRuntimeIdSchema }),
  z.object({ type: z.literal("host") }),
]);

const storedGitCredentialsV2Schema = z.enum(["auto", "none"]).default("auto");

const storedGitV2Schema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("readOnly"),
    gitCredentials: storedGitCredentialsV2Schema,
  }),
  z.object({
    mode: z.literal("readWrite"),
    message: z.string().nullable(),
    onPushFailure: z.enum(["fail", "warn"]),
    gitCredentials: storedGitCredentialsV2Schema,
  }),
]);

export const storedTaskExecutionConfigV2Schema = z.object({
  runtime: storedRuntimeV2Schema.nullable(),
  env: storedEnvVarsSchema.nullable(),
  git: storedGitV2Schema.nullable(),
  mcp: storedOpenCodeMcpServersSchema.nullable(),
  healthChecks: healthChecksSchema.nullable(),
});

export type TaskExecutionConfigContentV2 = z.output<
  typeof storedTaskExecutionConfigV2Schema
>;

const storedEnvironmentV3Schema = z.discriminatedUnion("kind", [
  storedEnvironmentFieldsSchema.extend({
    kind: z.literal("inline"),
    branch: z.string().optional(),
  }),
  z.object({ kind: z.literal("named"), name: z.string() }),
]);

export const storedTaskExecutionConfigV3Schema = z.object({
  environment: storedEnvironmentV3Schema.nullable(),
  git: storedGitV2Schema.nullable(),
  mcp: storedOpenCodeMcpServersSchema.nullable(),
  healthChecks: healthChecksSchema.nullable(),
});

export type TaskExecutionConfigContentV3 = z.output<
  typeof storedTaskExecutionConfigV3Schema
>;

/** Converts v2 runtime and env overrides into an inline environment. */
export const convertTaskExecutionConfigV2ToV3 = (
  content: TaskExecutionConfigContentV2,
): TaskExecutionConfigContentV3 => {
  const { runtime, env, ...rest } = content;
  if (runtime === null && env === null) {
    return { ...rest, environment: null };
  }

  const environment: NonNullable<TaskExecutionConfigContentV3["environment"]> =
    {
      kind: "inline",
    };
  if (runtime !== null) {
    switch (runtime.type) {
      case "host":
        environment.runtime = { kind: "host" };
        break;
      case "managed":
        environment.runtime = { kind: "managed", id: runtime.id };
        break;
      case "devcontainer":
        environment.runtime = {
          kind: "devcontainer",
          ...(runtime.configPath === undefined
            ? {}
            : { config: runtime.configPath }),
        };
        break;
    }
  }
  if (env !== null) environment.vars = env;
  return { ...rest, environment };
};

const storedGitV4Schema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("readOnly"),
    gitCredentials: z.enum(["auto", "none"]),
    baseBranch: z.string().nullable(),
  }),
  z.object({
    mode: z.literal("readWrite"),
    message: z.string().nullable(),
    onPushFailure: z.enum(["fail", "warn"]),
    gitCredentials: z.enum(["auto", "none"]),
    baseBranch: z.string().nullable(),
    workBranch: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("create") }),
      z.object({ kind: z.literal("base") }),
    ]),
  }),
]);

/** v4 inline environments have no `branch`: it moved to `git.baseBranch`. */
const storedEnvironmentV4Schema = z.discriminatedUnion("kind", [
  storedEnvironmentFieldsSchema.extend({ kind: z.literal("inline") }),
  z.object({ kind: z.literal("named"), name: z.string() }),
]);

export const storedTaskExecutionConfigV4Schema = z.object({
  environment: storedEnvironmentV4Schema.nullable(),
  git: storedGitV4Schema.nullable(),
  mcp: storedOpenCodeMcpServersSchema.nullable(),
  healthChecks: healthChecksSchema.nullable(),
});

export type TaskExecutionConfigContentV4 = z.output<
  typeof storedTaskExecutionConfigV4Schema
>;

/**
 * Fills the repo branch defaults and moves an inline environment's `branch`
 * to `git.baseBranch`. A `null` git (the default `readWrite` repo) becomes
 * that default with the moved `baseBranch`, so the branch still applies. A
 * `branch` that is not a valid base branch template (e.g. `""` or one with
 * tokens other than `input`, `env` and `workItem.platformKey`) is dropped:
 * the worker would reject it at startup.
 */
export const convertTaskExecutionConfigV3ToV4 = (
  content: TaskExecutionConfigContentV3,
): TaskExecutionConfigContentV4 => {
  let movedBranch: string | null = null;
  let environment: TaskExecutionConfigContentV4["environment"] =
    content.environment;
  if (content.environment?.kind === "inline") {
    const { branch, ...rest } = content.environment;
    environment = rest;
    if (
      branch !== undefined &&
      repoBaseBranchSchema.safeParse(branch).success
    ) {
      movedBranch = branch;
    }
  }

  const git = content.git;
  const branchDefaults = { baseBranch: movedBranch };
  let convertedGit: TaskExecutionConfigContentV4["git"];
  if (git === null) {
    convertedGit =
      movedBranch === null
        ? null
        : resolveRepoConfig({ mode: "readWrite", baseBranch: movedBranch });
  } else if (git.mode === "readOnly") {
    convertedGit = { ...git, ...branchDefaults };
  } else {
    convertedGit = {
      ...git,
      ...branchDefaults,
      workBranch: { kind: "create" },
    };
  }
  return { ...content, environment, git: convertedGit };
};

/** Converts immutable v1 content while preserving explicit and implicit noncommitting git modes. */
export const convertTaskExecutionConfigV1ToV2 = (
  content: TaskExecutionConfigContentV1,
): TaskExecutionConfigContentV2 => ({
  ...content,
  runtime:
    content.runtime?.type === "none" ? { type: "host" } : content.runtime,
  git:
    content.git?.mode === "none" ||
    (content.runtime?.type === "none" && content.git === null)
      ? { mode: "readOnly", gitCredentials: "none" }
      : content.git,
});

export const CURRENT_TASK_EXECUTION_CONFIG_SCHEMA_VERSION = 4;

/** The config content in the current version's shape. */
export type TaskExecutionConfigContent = TaskExecutionConfigContentV4;
export type StoredEnvironment = TaskExecutionConfigContent["environment"];
export type StoredRuntimeConfig = z.output<
  typeof storedEnvironmentRuntimeSchema
>;
export type StoredTaskExecutionConfigEnvVar = NonNullable<
  Extract<StoredEnvironment, { kind: "inline" }>["vars"]
>[number];
export type StoredGitConfig = NonNullable<TaskExecutionConfigContent["git"]>;

/** The stored content of each schema version. */
type TaskExecutionConfigContentByVersion = {
  1: TaskExecutionConfigContentV1;
  2: TaskExecutionConfigContentV2;
  3: TaskExecutionConfigContentV3;
  4: TaskExecutionConfigContentV4;
};

/** Every schema version a stored row may carry. */
export type TaskExecutionConfigSchemaVersion =
  keyof TaskExecutionConfigContentByVersion;

type StoredTaskExecutionConfigSharedColumns = {
  gitJson: unknown;
  mcpJson: unknown;
  healthChecksJson: unknown;
};

/** Historical payloads remain readable independently of the current DB columns. */
export type HistoricalTaskExecutionConfigColumns =
  StoredTaskExecutionConfigSharedColumns & {
    runtimeJson: unknown;
    envJson: unknown;
    environmentJson?: never;
  };

export type CurrentTaskExecutionConfigColumns =
  StoredTaskExecutionConfigSharedColumns & {
    environmentJson: unknown;
    runtimeJson?: never;
    envJson?: never;
  };

export type StoredTaskExecutionConfigColumns =
  HistoricalTaskExecutionConfigColumns | CurrentTaskExecutionConfigColumns;

/**
 * `vN → vN+1` converters keyed by `N`.
 */
export const taskExecutionConfigConverters: {
  [
    Version in Exclude<
      TaskExecutionConfigSchemaVersion,
      typeof CURRENT_TASK_EXECUTION_CONFIG_SCHEMA_VERSION
    >
  ]: (
    content: TaskExecutionConfigContentByVersion[Version],
  ) => TaskExecutionConfigContentByVersion[Version extends 1
    ? 2
    : Version extends 2
      ? 3
      : 4];
} = {
  1: convertTaskExecutionConfigV1ToV2,
  2: convertTaskExecutionConfigV2ToV3,
  3: convertTaskExecutionConfigV3ToV4,
};

type StoredContentReader = (
  columns: StoredTaskExecutionConfigColumns,
) => z.ZodSafeParseResult<TaskExecutionConfigContent>;

const storedContentOf = (columns: StoredTaskExecutionConfigColumns) => ({
  runtime: columns.runtimeJson,
  env: columns.envJson,
  git: columns.gitJson,
  mcp: columns.mcpJson,
  healthChecks: columns.healthChecksJson,
});

const currentStoredContentOf = (columns: StoredTaskExecutionConfigColumns) => ({
  environment: columns.environmentJson,
  git: columns.gitJson,
  mcp: columns.mcpJson,
  healthChecks: columns.healthChecksJson,
});

/**
 * Per stored version: parse with that version's stored schema, then convert
 * up to the current version through `taskExecutionConfigConverters`.
 */
const readStoredContentByVersion: Record<
  TaskExecutionConfigSchemaVersion,
  StoredContentReader
> = {
  1: (columns) =>
    storedTaskExecutionConfigV1Schema
      .transform(taskExecutionConfigConverters[1])
      .transform(taskExecutionConfigConverters[2])
      .transform(taskExecutionConfigConverters[3])
      .safeParse(storedContentOf(columns)),
  2: (columns) =>
    storedTaskExecutionConfigV2Schema
      .transform(taskExecutionConfigConverters[2])
      .transform(taskExecutionConfigConverters[3])
      .safeParse(storedContentOf(columns)),
  3: (columns) =>
    storedTaskExecutionConfigV3Schema
      .transform(taskExecutionConfigConverters[3])
      .safeParse(currentStoredContentOf(columns)),
  4: (columns) =>
    storedTaskExecutionConfigV4Schema.safeParse(
      currentStoredContentOf(columns),
    ),
};

const isKnownSchemaVersion = (
  version: number,
): version is TaskExecutionConfigSchemaVersion =>
  Object.hasOwn(readStoredContentByVersion, version);

export type ReadStoredTaskExecutionConfigResult =
  | { success: true; content: TaskExecutionConfigContent }
  | { success: false; reason: string };

/**
 * Reads a row's JSON columns at `schemaVersion` into the current version's
 * shape, or explains why the row is unreadable.
 */
export const readStoredTaskExecutionConfig = (
  schemaVersion: number,
  columns: StoredTaskExecutionConfigColumns,
): ReadStoredTaskExecutionConfigResult => {
  if (!isKnownSchemaVersion(schemaVersion)) {
    return {
      success: false,
      reason: `unknown schema_version ${String(schemaVersion)} (current is ${String(CURRENT_TASK_EXECUTION_CONFIG_SCHEMA_VERSION)})`,
    };
  }
  const parsed = readStoredContentByVersion[schemaVersion](columns);
  return parsed.success
    ? { success: true, content: parsed.data }
    : { success: false, reason: z.prettifyError(parsed.error) };
};
