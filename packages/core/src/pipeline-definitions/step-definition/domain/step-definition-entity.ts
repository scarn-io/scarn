import type {
  AnyJsonObject,
  AnyJsonValue,
} from "@scarn/core/common/contracts/json";
import {
  createUuidV7,
  parseUuidV7,
  type UuidV7,
} from "@scarn/core/common/contracts/uuid-v7";
import type { HealthCheck } from "@scarn/core/common/contracts/health-checks";
import { CoreValidationError } from "@scarn/core/lib/errors";
import type { RetryPolicyEntry } from "@scarn/core/tasks/task/domain/retry-decision";
import {
  grantKindRefusals,
  grantsSchema,
  type Grant,
} from "@scarn/core/tasks/task/domain/grants";
import { BUILT_IN_ERRORS } from "@scarn/sdk/contracts/pipeline-document";
import { normalizeDate } from "@scarn/core/work-items/work-item/domain/date-utils";

// `code` steps are plain functions instead of LLM prompts — the worker
// resolves `entrypointJson` (below) against the target repo's checkout, finds
// the step by its `key` in `sourceFile` and calls its function directly,
// skipping prompt rendering entirely. `mcp_tool` steps call one MCP tool on
// the worker with no LLM, described by `toolCallJson`. The
// dormant `built_in` value is left untouched for whatever first-party/
// shipped-by-Scarn meaning it may get later.
export const stepDefinitionKindValues = [
  "built_in",
  "user_defined",
  "code",
  "mcp_tool",
] as const;
export const stepDefinitionStatusValues = [
  "draft",
  "active",
  "archived",
] as const;

export type StepDefinitionKind = (typeof stepDefinitionKindValues)[number];
export type StepDefinitionStatus = (typeof stepDefinitionStatusValues)[number];

/**
 * A `kind: "code"` step's portable entrypoint: the module that defines the
 * step. The unserializable `fn` reference is never sent over the wire; the
 * worker later `import()`s `sourceFile` from its own checkout and locates the
 * step in that module by the step definition's `key`.
 */
export type StepDefinitionEntrypoint = {
  sourceFile: string;
};

/** A JSON Schema as stored: an object schema or a boolean schema. */
export type StoredJsonSchema = AnyJsonObject | boolean;

/**
 * A `kind: "mcp_tool"` step's tool call spec: the server key in the step's
 * `opencodeMcpJson`, the tool's name on that server, the args template
 * rendered against the step's input at run time, and the tool's JSON Schemas
 * from the catalog.
 */
export type StepDefinitionToolCall = {
  server: string;
  tool: string;
  argsTemplate: AnyJsonValue;
  toolSchemas: {
    input: StoredJsonSchema;
    output: StoredJsonSchema | null;
  };
};

export type StepDefinitionEntityProps = {
  id: UuidV7;
  projectId: UuidV7;
  key: string;
  name: string;
  description?: string | null | undefined;
  prompt?: string | null | undefined;
  version: number;
  kind: StepDefinitionKind;
  // Valid on `kind === "code"` only — see the constructor's kind-mismatch
  // checks.
  entrypointJson?: StepDefinitionEntrypoint | null | undefined;
  /** Valid on `kind === "mcp_tool"` only, which requires it. */
  toolCallJson?: StepDefinitionToolCall | null | undefined;
  inputSchemaJson: AnyJsonObject;
  /** Null: a conversation step, whose result is `{ conversationId, summary }`. Agent steps only. */
  resultSchemaJson: AnyJsonObject | null;
  /** Error names the step declares, which a pipeline's `retry.on`/`catch.on` may use. */
  errors?: readonly string[] | undefined;
  /**
   * The retry policy a standalone Task of this step copies, shaped like a
   * pipeline node's `retry`. `on` names built-in or declared errors.
   */
  retry?: readonly RetryPolicyEntry[] | undefined;
  /**
   * What a Task of this step may do. Every Task also gets `read` on `self`
   * (see `taskGrants`).
   */
  grants?: readonly Grant[] | undefined;
  /** How many times a standalone Task of this step may hand over; null for the default. */
  maxTurns?: number | null | undefined;
  /**
   * At most `max` live Tasks of this step run on one work item, and up to
   * `waiting` more wait for a slot; null for no limit.
   */
  concurrency?: StepConcurrency | null | undefined;
  /** `null` runs on the repo's own config (D3). */
  taskExecutionConfigId: UuidV7 | null;
  status: StepDefinitionStatus;
  createdAt?: Date | string | null | undefined;
  updatedAt?: Date | string | null | undefined;
};

/** A step's per-work-item concurrency limit. */
export type StepConcurrency = {
  max: number;
  waiting: number;
};

export type CreateStepDefinitionEntityProps = Omit<
  StepDefinitionEntityProps,
  "id"
> & {
  id?: UuidV7 | undefined;
};

const assertUniqueErrorNames = (values: readonly string[]) => {
  if (new Set(values).size !== values.length) {
    throw new CoreValidationError(
      "Step definition error names must be unique",
      "STEP_DEFINITION_ERROR_NAMES_NOT_UNIQUE",
    );
  }
};

const assertRetryPolicy = (
  retry: readonly RetryPolicyEntry[],
  declared: readonly string[],
) => {
  const known = new Set<string>([...BUILT_IN_ERRORS, ...declared]);
  for (const entry of retry) {
    if (entry.on.length === 0 || entry.on.some((name) => !name.trim())) {
      throw new CoreValidationError(
        "Step definition retry entries must name at least one error",
        "STEP_DEFINITION_RETRY_ON_REQUIRED",
      );
    }
    if (!Number.isInteger(entry.maxAttempts) || entry.maxAttempts <= 0) {
      throw new CoreValidationError(
        "Step definition retry maxAttempts must be a positive integer",
        "STEP_DEFINITION_RETRY_MAX_ATTEMPTS_INVALID",
      );
    }
    const unknown = entry.on.find((name) => !known.has(name));
    if (unknown !== undefined) {
      throw new CoreValidationError(
        `Step definition retry names "${unknown}", which is neither a built-in error nor one the step declares`,
        "STEP_DEFINITION_RETRY_UNKNOWN_ERROR",
      );
    }
  }
};

/**
 * An `mcp_tool` step calls one tool with no LLM: it needs a tool call naming
 * a server and a tool, and a result schema, and has no prompt or entrypoint.
 * The one-server rule needs the step's MCP servers, which live on its
 * execution config: see `assertToolCallFitsMcpServers`.
 */
const assertMcpToolStepShape = (props: StepDefinitionEntityProps) => {
  const toolCall = props.toolCallJson;
  if (!toolCall) {
    throw new CoreValidationError(
      "Step definition of kind 'mcp_tool' requires toolCallJson",
      "STEP_DEFINITION_TOOL_CALL_REQUIRED",
    );
  }
  if (!toolCall.server.trim() || !toolCall.tool.trim()) {
    throw new CoreValidationError(
      "Step definition toolCallJson must name a server and a tool",
      "STEP_DEFINITION_TOOL_CALL_INVALID",
    );
  }
  if (props.prompt?.trim()) {
    throw new CoreValidationError(
      "Step definition of kind 'mcp_tool' must not have a prompt",
      "STEP_DEFINITION_PROMPT_NOT_ALLOWED",
    );
  }
  if (props.resultSchemaJson === null) {
    throw new CoreValidationError(
      "Step definition of kind 'mcp_tool' requires a result schema",
      "STEP_DEFINITION_RESULT_SCHEMA_REQUIRED",
    );
  }
};

/**
 * An `mcp_tool` step declares exactly one MCP server, the one its tool call
 * names. Other kinds have no tool call, so nothing to check.
 */
export const assertToolCallFitsMcpServers = (
  kind: StepDefinitionKind,
  toolCall: Pick<StepDefinitionToolCall, "server"> | null | undefined,
  mcpServerKeys: readonly string[],
): void => {
  if (kind !== "mcp_tool" || !toolCall) return;
  if (mcpServerKeys.length !== 1 || mcpServerKeys[0] !== toolCall.server) {
    throw new CoreValidationError(
      `Step definition of kind 'mcp_tool' must declare exactly one MCP server, the one its tool call names ("${toolCall.server}")`,
      "STEP_DEFINITION_TOOL_CALL_SERVER_MISMATCH",
    );
  }
};

/**
 * A `code` step has no agent to run CLI or plugin-tool checks: each health
 * check must be a `tool` check on one of its MCP servers. That the server
 * exists is the execution config's rule
 * (`TASK_EXECUTION_CONFIG_HEALTH_CHECK_MCP_UNKNOWN`). Other kinds are not
 * restricted here.
 */
export const assertHealthChecksFitStepKind = (
  kind: StepDefinitionKind,
  healthChecks: readonly HealthCheck[] | null | undefined,
): void => {
  if (kind !== "code") return;
  for (const [index, check] of (healthChecks ?? []).entries()) {
    if (check.kind !== "tool" || check.mcp === undefined) {
      throw new CoreValidationError(
        `health check #${String(index + 1)}: a step of kind 'code' allows only 'tool' health checks that name one of its MCP servers`,
        "STEP_DEFINITION_HEALTH_CHECK_NOT_ALLOWED",
      );
    }
  }
};

export class StepDefinitionEntity {
  public readonly id: UuidV7;
  public readonly projectId: UuidV7;
  public readonly key: string;
  public readonly name: string;
  public readonly description: string | null;
  public readonly prompt: string | null;
  public readonly version: number;
  public readonly kind: StepDefinitionKind;
  public readonly entrypointJson: StepDefinitionEntrypoint | null;
  public readonly toolCallJson: StepDefinitionToolCall | null;
  public readonly inputSchemaJson: AnyJsonObject;
  public readonly resultSchemaJson: AnyJsonObject | null;
  public readonly errors: readonly string[];
  public readonly retry: readonly RetryPolicyEntry[];
  public readonly grants: readonly Grant[];
  public readonly maxTurns: number | null;
  public readonly concurrency: StepConcurrency | null;
  public readonly taskExecutionConfigId: UuidV7 | null;
  public readonly status: StepDefinitionStatus;
  public readonly createdAt: Date | null | undefined;
  public readonly updatedAt: Date | null | undefined;

  private constructor(props: StepDefinitionEntityProps) {
    this.id = parseUuidV7(props.id);
    this.projectId = parseUuidV7(props.projectId);
    this.key = props.key;
    this.name = props.name;
    this.description = props.description ?? null;
    this.prompt = props.prompt ?? null;
    this.version = props.version;
    this.kind = props.kind;
    this.entrypointJson = props.entrypointJson ?? null;
    this.toolCallJson = props.toolCallJson ?? null;
    this.inputSchemaJson = props.inputSchemaJson;
    this.resultSchemaJson = props.resultSchemaJson;
    this.errors = props.errors ?? [];
    this.retry = props.retry ?? [];
    this.grants = props.grants ?? [];
    this.maxTurns = props.maxTurns ?? null;
    this.concurrency = props.concurrency ?? null;
    this.taskExecutionConfigId =
      props.taskExecutionConfigId === null
        ? null
        : parseUuidV7(props.taskExecutionConfigId);
    this.status = props.status;
    this.createdAt = normalizeDate(props.createdAt);
    this.updatedAt = normalizeDate(props.updatedAt);
  }

  /**
   * Applies the write rules to new or changed props and returns them
   * normalized (trimmed names, copied lists, parsed grants). `rehydrate`
   * skips this: a stored step definition is trusted as written, so
   * tightening a rule never makes one unreadable.
   */
  private static validated(
    props: StepDefinitionEntityProps,
  ): StepDefinitionEntityProps {
    const key = props.key.trim();
    const name = props.name.trim();

    if (!key) {
      throw new CoreValidationError(
        "Step definition key is required",
        "STEP_DEFINITION_KEY_REQUIRED",
      );
    }

    if (!name) {
      throw new CoreValidationError(
        "Step definition name is required",
        "STEP_DEFINITION_NAME_REQUIRED",
      );
    }

    if (!Number.isInteger(props.version) || props.version <= 0) {
      throw new CoreValidationError(
        "Step definition version must be a positive integer",
        "STEP_DEFINITION_VERSION_INVALID",
      );
    }

    // `code` steps are plain functions, not prompts: they require a
    // resolved entrypoint and must not carry a prompt. `user_defined` steps
    // are the inverse (a prompt is how they do their work) — this closes a
    // previously-silent gap (the constructor applied zero kind-specific
    // validation before). `built_in` is left unvalidated, matching its own
    // still-dormant status.
    if (props.kind === "code") {
      const entrypointJson = props.entrypointJson;
      if (!entrypointJson || !entrypointJson.sourceFile.trim()) {
        throw new CoreValidationError(
          "Step definition of kind 'code' requires entrypointJson: { sourceFile }",
          "STEP_DEFINITION_ENTRYPOINT_REQUIRED",
        );
      }

      if (props.prompt?.trim()) {
        throw new CoreValidationError(
          "Step definition of kind 'code' must not have a prompt",
          "STEP_DEFINITION_PROMPT_NOT_ALLOWED",
        );
      }

      if (props.resultSchemaJson === null) {
        throw new CoreValidationError(
          "Step definition of kind 'code' requires a result schema",
          "STEP_DEFINITION_RESULT_SCHEMA_REQUIRED",
        );
      }
    } else if (props.entrypointJson != null) {
      throw new CoreValidationError(
        `Step definition of kind '${props.kind}' must not have entrypointJson`,
        "STEP_DEFINITION_ENTRYPOINT_NOT_ALLOWED",
      );
    }

    if (props.kind === "user_defined" && !props.prompt?.trim()) {
      throw new CoreValidationError(
        "Step definition of kind 'user_defined' requires a prompt",
        "STEP_DEFINITION_PROMPT_REQUIRED",
      );
    }

    if (props.kind === "mcp_tool") {
      assertMcpToolStepShape(props);
    } else if (props.toolCallJson != null) {
      throw new CoreValidationError(
        `Step definition of kind '${props.kind}' must not have toolCallJson`,
        "STEP_DEFINITION_TOOL_CALL_NOT_ALLOWED",
      );
    }

    const errors = (props.errors ?? []).map((name) => name.trim());
    if (errors.some((name) => !name)) {
      throw new CoreValidationError(
        "Step definition error names must not be empty",
        "STEP_DEFINITION_ERROR_NAME_REQUIRED",
      );
    }
    assertUniqueErrorNames(errors);
    const retry = (props.retry ?? []).map((entry) => ({
      on: [...entry.on],
      maxAttempts: entry.maxAttempts,
    }));
    assertRetryPolicy(retry, errors);
    const parsedGrants = grantsSchema.safeParse(props.grants ?? []);
    if (!parsedGrants.success) {
      throw new CoreValidationError(
        `Step definition grants are invalid: ${parsedGrants.error.issues.map((issue) => issue.message).join("; ")}`,
        "STEP_DEFINITION_GRANTS_INVALID",
      );
    }
    const kindRefusals = grantKindRefusals(props.kind, parsedGrants.data);
    if (kindRefusals.length > 0) {
      throw new CoreValidationError(
        `Step definition grants are invalid: ${kindRefusals.join("; ")}`,
        "STEP_DEFINITION_GRANTS_INVALID",
      );
    }
    const maxTurns = props.maxTurns ?? null;
    if (maxTurns !== null && (!Number.isInteger(maxTurns) || maxTurns <= 0)) {
      throw new CoreValidationError(
        "Step definition maxTurns must be a positive integer",
        "STEP_DEFINITION_MAX_TURNS_INVALID",
      );
    }
    const concurrency = props.concurrency
      ? { max: props.concurrency.max, waiting: props.concurrency.waiting }
      : null;
    if (concurrency !== null) {
      if (!Number.isInteger(concurrency.max) || concurrency.max < 1) {
        throw new CoreValidationError(
          "Step definition concurrency max must be an integer of at least 1",
          "STEP_DEFINITION_CONCURRENCY_MAX_INVALID",
        );
      }
      if (!Number.isInteger(concurrency.waiting) || concurrency.waiting < 0) {
        throw new CoreValidationError(
          "Step definition concurrency waiting must be a non-negative integer",
          "STEP_DEFINITION_CONCURRENCY_WAITING_INVALID",
        );
      }
    }

    return {
      ...props,
      key,
      name,
      description: props.description?.trim() || null,
      prompt: props.prompt?.trim() || null,
      entrypointJson: props.entrypointJson ?? null,
      toolCallJson: props.toolCallJson ?? null,
      errors,
      retry,
      grants: parsedGrants.data,
      maxTurns,
      concurrency,
    };
  }

  static create(props: CreateStepDefinitionEntityProps): StepDefinitionEntity {
    return new StepDefinitionEntity(
      StepDefinitionEntity.validated({
        ...props,
        id: props.id ?? createUuidV7(),
      }),
    );
  }

  /** Trusts `props` as stored; see {@link StepDefinitionEntity.validated}. */
  static rehydrate(props: StepDefinitionEntityProps): StepDefinitionEntity {
    return new StepDefinitionEntity(props);
  }

  /**
   * Replaces this step definition's fields, applying the write rules. The id
   * and `createdAt` are kept.
   */
  update(
    props: Omit<StepDefinitionEntityProps, "id" | "createdAt">,
  ): StepDefinitionEntity {
    return new StepDefinitionEntity(
      StepDefinitionEntity.validated({
        ...props,
        id: this.id,
        createdAt: this.createdAt,
      }),
    );
  }

  archive(now: Date): StepDefinitionEntity {
    return new StepDefinitionEntity({
      ...this.toJSON(),
      status: "archived",
      updatedAt: now,
    });
  }

  toJSON(): StepDefinitionEntityProps {
    return {
      id: this.id,
      projectId: this.projectId,
      key: this.key,
      name: this.name,
      description: this.description,
      prompt: this.prompt,
      version: this.version,
      kind: this.kind,
      entrypointJson: this.entrypointJson,
      toolCallJson: this.toolCallJson,
      inputSchemaJson: this.inputSchemaJson,
      resultSchemaJson: this.resultSchemaJson,
      errors: this.errors,
      retry: this.retry,
      grants: this.grants,
      maxTurns: this.maxTurns,
      concurrency: this.concurrency,
      taskExecutionConfigId: this.taskExecutionConfigId,
      status: this.status,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }
}
