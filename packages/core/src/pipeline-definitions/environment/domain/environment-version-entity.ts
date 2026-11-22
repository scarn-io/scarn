import { createHash } from "node:crypto";
import {
  createUuidV7,
  parseUuidV7,
  type UuidV7,
} from "@scarn/core/common/contracts/uuid-v7";
import {
  environmentContentSchema,
  type EnvironmentContent,
  type EnvironmentContentInput,
} from "@scarn/core/common/contracts/environment";
import { canonicalJson } from "@scarn/core/lib/canonical-json";
import { CoreValidationError } from "@scarn/core/lib/errors";
import { z } from "zod";
import { CURRENT_ENVIRONMENT_CONTENT_SCHEMA_VERSION } from "../contracts/environment-content-stored";

export type EnvironmentVersionEntityProps = {
  id: UuidV7;
  environmentId: UuidV7;
  version: number;
  content: EnvironmentContent;
  contentHash: string;
  createdByUserId: UuidV7;
  createdAt: Date;
};

/**
 * Validates `input` against the strict write schema and drops empty `vars`
 * and `connectors`, so `[]` and an omitted field are the same content.
 */
export const normalizeEnvironmentContent = (
  input: EnvironmentContentInput,
): EnvironmentContent => {
  const parsed = environmentContentSchema.safeParse(input);
  if (!parsed.success) {
    throw new CoreValidationError(
      `Invalid environment content:\n${z.prettifyError(parsed.error)}`,
      "ENVIRONMENT_CONTENT_INVALID",
    );
  }
  const { vars, connectors, ...rest } = parsed.data;
  return {
    ...rest,
    ...(vars === undefined || vars.length === 0 ? {} : { vars }),
    ...(connectors === undefined || connectors.length === 0
      ? {}
      : { connectors }),
  };
};

/**
 * sha256 of the canonical JSON of the content and the current schema
 * version. Object key order is ignored; array order is significant.
 */
export const hashEnvironmentContent = (content: EnvironmentContent): string =>
  createHash("sha256")
    .update(
      canonicalJson({
        schemaVersion: CURRENT_ENVIRONMENT_CONTENT_SCHEMA_VERSION,
        content,
      }),
    )
    .digest("hex");

/** One published version of a named environment. Never changes once stored. */
export class EnvironmentVersionEntity {
  public readonly id: UuidV7;
  public readonly environmentId: UuidV7;
  public readonly version: number;
  public readonly content: EnvironmentContent;
  public readonly contentHash: string;
  public readonly createdByUserId: UuidV7;
  public readonly createdAt: Date;

  private constructor(props: EnvironmentVersionEntityProps) {
    if (!Number.isInteger(props.version) || props.version < 1) {
      throw new CoreValidationError(
        "Environment version must be a positive integer",
        "ENVIRONMENT_VERSION_INVALID",
      );
    }
    if (!props.contentHash.trim()) {
      throw new CoreValidationError(
        "Environment version content hash is required",
        "ENVIRONMENT_VERSION_HASH_REQUIRED",
      );
    }
    this.id = parseUuidV7(props.id);
    this.environmentId = parseUuidV7(props.environmentId);
    this.version = props.version;
    this.content = props.content;
    this.contentHash = props.contentHash;
    this.createdByUserId = parseUuidV7(props.createdByUserId);
    this.createdAt = props.createdAt;
    Object.freeze(this);
  }

  /** Validates and normalizes `content`, and hashes it. */
  static create(props: {
    environmentId: UuidV7;
    version: number;
    content: EnvironmentContentInput;
    createdByUserId: UuidV7;
    createdAt: Date;
  }): EnvironmentVersionEntity {
    const content = normalizeEnvironmentContent(props.content);
    return new EnvironmentVersionEntity({
      id: createUuidV7(),
      environmentId: props.environmentId,
      version: props.version,
      content,
      contentHash: hashEnvironmentContent(content),
      createdByUserId: props.createdByUserId,
      createdAt: props.createdAt,
    });
  }

  /** Rebuilds a stored version whose content was already read through the stored schemas. */
  static rehydrate(
    props: EnvironmentVersionEntityProps,
  ): EnvironmentVersionEntity {
    return new EnvironmentVersionEntity(props);
  }

  toJSON(): EnvironmentVersionEntityProps {
    return {
      id: this.id,
      environmentId: this.environmentId,
      version: this.version,
      content: this.content,
      contentHash: this.contentHash,
      createdByUserId: this.createdByUserId,
      createdAt: this.createdAt,
    };
  }
}
