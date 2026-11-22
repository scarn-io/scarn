import {
  createUuidV7,
  parseUuidV7,
  type UuidV7,
} from "@scarn/core/common/contracts/uuid-v7";
import { CoreValidationError } from "@scarn/core/lib/errors";
import { normalizeDate } from "@scarn/core/work-items/work-item/domain/date-utils";

export type PipelineGraphEntityProps = {
  id: UuidV7;
  projectId: UuidV7;
  key: string;
  name: string;
  currentVersionId?: UuidV7 | null | undefined;
  archivedAt?: Date | string | null | undefined;
  createdAt?: Date | string | null | undefined;
  updatedAt?: Date | string | null | undefined;
};

export type CreatePipelineGraphEntityProps = Omit<
  PipelineGraphEntityProps,
  "id"
> & {
  id?: UuidV7 | undefined;
};

export class PipelineGraphEntity {
  public readonly id: UuidV7;
  public readonly projectId: UuidV7;
  public readonly key: string;
  public readonly name: string;
  public readonly currentVersionId: UuidV7 | null;
  public readonly archivedAt: Date | null;
  public readonly createdAt: Date | null | undefined;
  public readonly updatedAt: Date | null | undefined;

  private constructor(props: PipelineGraphEntityProps) {
    const key = props.key.trim();
    const name = props.name.trim();

    if (!key) {
      throw new CoreValidationError(
        "Pipeline graph key is required",
        "PIPELINE_GRAPH_KEY_REQUIRED",
      );
    }

    if (!name) {
      throw new CoreValidationError(
        "Pipeline graph name is required",
        "PIPELINE_GRAPH_NAME_REQUIRED",
      );
    }

    this.id = parseUuidV7(props.id);
    this.projectId = parseUuidV7(props.projectId);
    this.key = key;
    this.name = name;
    this.currentVersionId = props.currentVersionId
      ? parseUuidV7(props.currentVersionId)
      : null;
    this.archivedAt = normalizeDate(props.archivedAt) ?? null;
    this.createdAt = normalizeDate(props.createdAt);
    this.updatedAt = normalizeDate(props.updatedAt);
  }

  get isArchived(): boolean {
    return this.archivedAt !== null;
  }

  static create(props: CreatePipelineGraphEntityProps): PipelineGraphEntity {
    return new PipelineGraphEntity({
      ...props,
      id: props.id ?? createUuidV7(),
    });
  }

  static rehydrate(props: PipelineGraphEntityProps): PipelineGraphEntity {
    return new PipelineGraphEntity(props);
  }

  rename(name: string, now: Date): PipelineGraphEntity {
    return new PipelineGraphEntity({
      ...this.toJSON(),
      name,
      updatedAt: now,
    });
  }

  withCurrentVersionId(
    currentVersionId: UuidV7,
    now: Date,
  ): PipelineGraphEntity {
    return new PipelineGraphEntity({
      ...this.toJSON(),
      currentVersionId,
      updatedAt: now,
    });
  }

  archive(now: Date): PipelineGraphEntity {
    return new PipelineGraphEntity({
      ...this.toJSON(),
      archivedAt: this.archivedAt ?? now,
      updatedAt: now,
    });
  }

  unarchive(now: Date): PipelineGraphEntity {
    return new PipelineGraphEntity({
      ...this.toJSON(),
      archivedAt: null,
      updatedAt: now,
    });
  }

  toJSON(): PipelineGraphEntityProps {
    return {
      id: this.id,
      projectId: this.projectId,
      key: this.key,
      name: this.name,
      currentVersionId: this.currentVersionId,
      archivedAt: this.archivedAt,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }
}
