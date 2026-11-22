import {
  createUuidV7,
  parseUuidV7,
  type UuidV7,
} from "@scarn/core/common/contracts/uuid-v7";
import { CoreValidationError } from "@scarn/core/lib/errors";
import { normalizeDate } from "@scarn/core/work-items/work-item/domain/date-utils";
import type { AutomationDocument } from "@scarn/sdk/contracts/automation-document";

export type AutomationVersionEntityProps = {
  id: UuidV7;
  automationId: UuidV7;
  version: number;
  document: AutomationDocument;
  schemaVersion: number;
  contentHash: string;
  publishedAt: Date | string;
};

export type CreateAutomationVersionEntityProps = Omit<
  AutomationVersionEntityProps,
  "id"
> & { id?: UuidV7 | undefined };

/** One published version of an automation: a validated document. Never changes once stored. */
export class AutomationVersionEntity {
  public readonly id: UuidV7;
  public readonly automationId: UuidV7;
  public readonly version: number;
  public readonly document: AutomationDocument;
  public readonly schemaVersion: number;
  public readonly contentHash: string;
  public readonly publishedAt: Date;

  private constructor(props: AutomationVersionEntityProps) {
    if (!Number.isInteger(props.version) || props.version < 1) {
      throw new CoreValidationError(
        "Automation version must be a positive integer",
        "AUTOMATION_VERSION_INVALID",
      );
    }
    const publishedAt = normalizeDate(props.publishedAt);
    if (!publishedAt) {
      throw new CoreValidationError(
        "Automation version needs a publish time",
        "AUTOMATION_VERSION_PUBLISHED_AT_REQUIRED",
      );
    }
    this.id = parseUuidV7(props.id);
    this.automationId = parseUuidV7(props.automationId);
    this.version = props.version;
    this.document = props.document;
    this.schemaVersion = props.schemaVersion;
    this.contentHash = props.contentHash;
    this.publishedAt = publishedAt;
  }

  static create(
    props: CreateAutomationVersionEntityProps,
  ): AutomationVersionEntity {
    return new AutomationVersionEntity({
      ...props,
      id: props.id ?? createUuidV7(),
    });
  }

  static rehydrate(
    props: AutomationVersionEntityProps,
  ): AutomationVersionEntity {
    return new AutomationVersionEntity(props);
  }
}
