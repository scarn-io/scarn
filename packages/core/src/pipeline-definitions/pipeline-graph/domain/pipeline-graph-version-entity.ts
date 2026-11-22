import {
  createUuidV7,
  parseUuidV7,
  type UuidV7,
} from "@scarn/core/common/contracts/uuid-v7";
import { CoreValidationError } from "@scarn/core/lib/errors";
import { normalizeDate } from "@scarn/core/work-items/work-item/domain/date-utils";
import {
  pipelineDocumentSchema,
  type PipelineDocument,
} from "@scarn/sdk/contracts/pipeline-document";

/** The step version a pipeline version runs for one step key. */
export type PinnedStep = {
  stepKey: string;
  stepDefinitionId: UuidV7;
};

export type PipelineGraphVersionEntityProps = {
  id: UuidV7;
  pipelineGraphId: UuidV7;
  version: number;
  definitionJson: PipelineDocument;
  schemaVersion: number;
  contentHash: string;
  steps: readonly PinnedStep[];
  createdAt?: Date | string | null | undefined;
};

export type CreatePipelineGraphVersionEntityProps = Omit<
  PipelineGraphVersionEntityProps,
  "id"
> & { id?: UuidV7 | undefined };

/**
 * One published version of a pipeline: a validated JSON document plus the
 * step versions it was pinned to when published. Never changes once stored.
 */
export class PipelineGraphVersionEntity {
  public readonly id: UuidV7;
  public readonly pipelineGraphId: UuidV7;
  public readonly version: number;
  public readonly definitionJson: PipelineDocument;
  public readonly schemaVersion: number;
  public readonly contentHash: string;
  public readonly steps: readonly PinnedStep[];
  public readonly createdAt: Date | null | undefined;

  private constructor(props: PipelineGraphVersionEntityProps) {
    if (!Number.isInteger(props.version) || props.version < 1) {
      throw new CoreValidationError(
        "Pipeline version must be a positive integer",
        "PIPELINE_GRAPH_VERSION_INVALID",
      );
    }
    if (!props.contentHash.trim()) {
      throw new CoreValidationError(
        "Pipeline version content hash is required",
        "PIPELINE_GRAPH_VERSION_HASH_REQUIRED",
      );
    }
    this.id = parseUuidV7(props.id);
    this.pipelineGraphId = parseUuidV7(props.pipelineGraphId);
    this.version = props.version;
    this.definitionJson = pipelineDocumentSchema.parse(props.definitionJson);
    this.schemaVersion = props.schemaVersion;
    this.contentHash = props.contentHash;
    this.steps = props.steps.map((step) => ({
      stepKey: step.stepKey,
      stepDefinitionId: parseUuidV7(step.stepDefinitionId),
    }));
    this.createdAt = normalizeDate(props.createdAt);
  }

  static create(
    props: CreatePipelineGraphVersionEntityProps,
  ): PipelineGraphVersionEntity {
    return new PipelineGraphVersionEntity({
      ...props,
      id: props.id ?? createUuidV7(),
    });
  }

  static rehydrate(
    props: PipelineGraphVersionEntityProps,
  ): PipelineGraphVersionEntity {
    return new PipelineGraphVersionEntity(props);
  }

  /** The pinned step definition id for `stepKey`, or null when the document doesn't use it. */
  stepDefinitionIdFor(stepKey: string): UuidV7 | null {
    return (
      this.steps.find((step) => step.stepKey === stepKey)?.stepDefinitionId ??
      null
    );
  }

  toJSON(): PipelineGraphVersionEntityProps {
    return {
      id: this.id,
      pipelineGraphId: this.pipelineGraphId,
      version: this.version,
      definitionJson: this.definitionJson,
      schemaVersion: this.schemaVersion,
      contentHash: this.contentHash,
      steps: this.steps,
      createdAt: this.createdAt,
    };
  }
}
