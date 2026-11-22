import { createHash } from "node:crypto";
import {
  createUuidV7,
  parseUuidV7,
  type UuidV7,
} from "@scarn/core/common/contracts/uuid-v7";
import { canonicalJson } from "@scarn/core/lib/canonical-json";
import { CoreValidationError } from "@scarn/core/lib/errors";
import { normalizeDate } from "@scarn/core/work-items/work-item/domain/date-utils";
import { z } from "zod";
import {
  type TaskExecutionConfigContentInput,
  type TaskExecutionConfigGitInput,
  taskExecutionConfigContentSchema,
} from "../contracts/task-execution-config-contracts";
import {
  CURRENT_TASK_EXECUTION_CONFIG_SCHEMA_VERSION,
  type StoredGitConfig,
  type TaskExecutionConfigContent,
} from "../contracts/task-execution-config-stored";
import { assertTaskExecutionConfigCrossFieldRules } from "./task-execution-config-cross-field-rules";
import { resolveTaskExecutionConfigGit } from "./task-execution-config-git";

export type TaskExecutionConfigEntityProps = {
  id: UuidV7;
  projectId: UuidV7;
  content: TaskExecutionConfigContent;
  createdAt?: Date | string | null | undefined;
};

export type CreateTaskExecutionConfigEntityProps = {
  id?: UuidV7 | undefined;
  projectId: UuidV7;
  content: TaskExecutionConfigContentInput;
  createdAt?: Date | string | null | undefined;
};

const nonEmptyArrayOrNull = <T>(values: T[] | null): T[] | null =>
  values !== null && values.length > 0 ? values : null;

const nonEmptyRecordOrNull = <T extends object>(value: T | null): T | null =>
  value !== null && Object.keys(value).length > 0 ? value : null;

/**
 * Resolves independent repo defaults (D9). A mode equal to the
 * default is stored as `null`, which already means "the default",
 * so restating the default does not create a distinct row.
 */
const normalizeGit = (
  input: TaskExecutionConfigGitInput | null,
): StoredGitConfig | null => {
  if (input === null) return null;
  const git = resolveTaskExecutionConfigGit(input);
  return canonicalJson(git) ===
    canonicalJson(resolveTaskExecutionConfigGit(null))
    ? null
    : git;
};

/**
 * The `git` value as hashed: the default `gitCredentials: "auto"` is left
 * out, so rows hashed before the field existed keep deduplicating against
 * new ones.
 */
const hashedGit = (git: StoredGitConfig | null) => {
  if (git === null || git.gitCredentials !== "auto") {
    return git;
  }
  const hashed: Partial<StoredGitConfig> = { ...git };
  delete hashed.gitCredentials;
  return hashed;
};

/**
 * One immutable set of overrides a step definition or Task runs with on top
 * of the repo's own config (D2). Every field is `null` when the repo's
 * config applies; a config with every field `null` is empty and is stored
 * as a `null` reference, never as a row (D3). Rows are deduplicated per
 * project by `contentHash()` (D7).
 */
export class TaskExecutionConfigEntity {
  public readonly id: UuidV7;
  public readonly projectId: UuidV7;
  public readonly environment: TaskExecutionConfigContent["environment"];
  /** `null` means the runtime's default repo mode applies (D9). */
  public readonly git: StoredGitConfig | null;
  public readonly mcp: TaskExecutionConfigContent["mcp"];
  public readonly healthChecks: TaskExecutionConfigContent["healthChecks"];
  public readonly createdAt: Date | null | undefined;

  private constructor(props: TaskExecutionConfigEntityProps) {
    this.id = parseUuidV7(props.id);
    this.projectId = parseUuidV7(props.projectId);
    this.environment = props.content.environment;
    this.git = props.content.git;
    this.mcp = props.content.mcp;
    this.healthChecks = props.content.healthChecks;
    this.createdAt = normalizeDate(props.createdAt);
    Object.freeze(this);
  }

  /**
   * Validates `content` against the strict write schemas, normalizes empty
   * lists and maps to `null`, resolves `git` against the runtime (D9) and
   * applies the cross-field rules (D14).
   */
  static create(
    props: CreateTaskExecutionConfigEntityProps,
  ): TaskExecutionConfigEntity {
    const parsed = taskExecutionConfigContentSchema.safeParse(props.content);
    if (!parsed.success) {
      throw new CoreValidationError(
        `Invalid task execution config:\n${z.prettifyError(parsed.error)}`,
        "TASK_EXECUTION_CONFIG_INVALID",
      );
    }

    const environment = parsed.data.environment;
    if (environment?.kind === "inline" && environment.vars?.length === 0) {
      delete environment.vars;
    }
    const content: TaskExecutionConfigContent = {
      environment,
      git: normalizeGit(parsed.data.git),
      mcp: nonEmptyRecordOrNull(parsed.data.mcp),
      healthChecks: nonEmptyArrayOrNull(parsed.data.healthChecks),
    };
    assertTaskExecutionConfigCrossFieldRules(content);

    return new TaskExecutionConfigEntity({
      id: props.id ?? createUuidV7(),
      projectId: props.projectId,
      content,
      createdAt: props.createdAt,
    });
  }

  /** Rebuilds a stored config whose content was already read through the stored schemas. */
  static rehydrate(
    props: TaskExecutionConfigEntityProps,
  ): TaskExecutionConfigEntity {
    return new TaskExecutionConfigEntity(props);
  }

  /**
   * A new config (with a new id) that runs in the named environment `name`
   * and keeps this config's `git`, `mcp` and `healthChecks`.
   */
  withNamedEnvironment(name: string): TaskExecutionConfigEntity {
    return new TaskExecutionConfigEntity({
      id: createUuidV7(),
      projectId: this.projectId,
      content: { ...this.content(), environment: { kind: "named", name } },
    });
  }

  isEmpty(): boolean {
    return (
      this.environment === null &&
      this.git === null &&
      this.mcp === null &&
      this.healthChecks === null
    );
  }

  /**
   * sha256 of the canonical JSON of the content and the current schema
   * version (D7). Object key order is ignored; array order is significant.
   * A default `git.gitCredentials` is not hashed (see `hashedGit`).
   */
  contentHash(): string {
    return createHash("sha256")
      .update(
        canonicalJson({
          schemaVersion: CURRENT_TASK_EXECUTION_CONFIG_SCHEMA_VERSION,
          ...this.content(),
          git: hashedGit(this.git),
        }),
      )
      .digest("hex");
  }

  content(): TaskExecutionConfigContent {
    return {
      environment: this.environment,
      git: this.git,
      mcp: this.mcp,
      healthChecks: this.healthChecks,
    };
  }

  toJSON(): TaskExecutionConfigEntityProps {
    return {
      id: this.id,
      projectId: this.projectId,
      content: this.content(),
      createdAt: this.createdAt,
    };
  }
}
