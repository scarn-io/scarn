import {
  createUuidV7,
  parseUuidV7,
  type UuidV7,
} from "@scarn/core/common/contracts/uuid-v7";
import { environmentNameSchema } from "@scarn/core/common/contracts/environment";
import { CoreValidationError } from "@scarn/core/lib/errors";

export type EnvironmentEntityProps = {
  id: UuidV7;
  projectId: UuidV7;
  name: string;
  /** The highest version number published; 0 before the first publish. */
  latestVersion: number;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * A project's named environment: a name with numbered, immutable versions
 * (`EnvironmentVersionEntity`). Deleting is soft. A deleted name published
 * again is restored on the same row, so its version numbers carry on.
 */
export class EnvironmentEntity {
  public readonly id: UuidV7;
  public readonly projectId: UuidV7;
  public readonly name: string;
  public readonly latestVersion: number;
  public readonly deletedAt: Date | null;
  public readonly createdAt: Date;
  public readonly updatedAt: Date;

  private constructor(props: EnvironmentEntityProps) {
    if (!environmentNameSchema.safeParse(props.name).success) {
      throw new CoreValidationError(
        `Environment name "${props.name}" must match /^[a-z0-9][a-z0-9-]*$/`,
        "ENVIRONMENT_NAME_INVALID",
      );
    }
    if (!Number.isInteger(props.latestVersion) || props.latestVersion < 0) {
      throw new CoreValidationError(
        "Environment latest version must be a non-negative integer",
        "ENVIRONMENT_LATEST_VERSION_INVALID",
      );
    }
    this.id = parseUuidV7(props.id);
    this.projectId = parseUuidV7(props.projectId);
    this.name = props.name;
    this.latestVersion = props.latestVersion;
    this.deletedAt = props.deletedAt;
    this.createdAt = props.createdAt;
    this.updatedAt = props.updatedAt;
    Object.freeze(this);
  }

  /** A new environment with no versions yet; `publishVersion` gives it version 1. */
  static create(props: {
    projectId: UuidV7;
    name: string;
    now: Date;
  }): EnvironmentEntity {
    return new EnvironmentEntity({
      id: createUuidV7(),
      projectId: props.projectId,
      name: props.name,
      latestVersion: 0,
      deletedAt: null,
      createdAt: props.now,
      updatedAt: props.now,
    });
  }

  static rehydrate(props: EnvironmentEntityProps): EnvironmentEntity {
    return new EnvironmentEntity(props);
  }

  get isDeleted(): boolean {
    return this.deletedAt !== null;
  }

  /** The number the next published version takes. */
  get nextVersion(): number {
    return this.latestVersion + 1;
  }

  /** Records a newly published version, restoring a deleted environment. */
  publishVersion(version: number, now: Date): EnvironmentEntity {
    if (version !== this.nextVersion) {
      throw new CoreValidationError(
        `Environment "${this.name}" expects version ${String(this.nextVersion)}, got ${String(version)}`,
        "ENVIRONMENT_VERSION_OUT_OF_ORDER",
      );
    }
    return new EnvironmentEntity({
      ...this.toJSON(),
      latestVersion: version,
      deletedAt: null,
      updatedAt: now,
    });
  }

  /** Restores a deleted environment without adding a version. */
  restore(now: Date): EnvironmentEntity {
    if (!this.isDeleted) return this;
    return new EnvironmentEntity({
      ...this.toJSON(),
      deletedAt: null,
      updatedAt: now,
    });
  }

  delete(now: Date): EnvironmentEntity {
    if (this.isDeleted) return this;
    return new EnvironmentEntity({
      ...this.toJSON(),
      deletedAt: now,
      updatedAt: now,
    });
  }

  toJSON(): EnvironmentEntityProps {
    return {
      id: this.id,
      projectId: this.projectId,
      name: this.name,
      latestVersion: this.latestVersion,
      deletedAt: this.deletedAt,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }
}
