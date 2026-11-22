import { CoreValidationError } from "@scarn/core/lib/errors";
import { normalizeDate } from "./date-utils";
import { parseWorkItemId, type WorkItemId } from "./work-item-id";

export type WorkItemProjectionFingerprintProps = {
  workItemId: WorkItemId;
  specId: string;
  fingerprint: string;
  canonicalContent: string;
  createdAt?: Date | string | null | undefined;
  updatedAt?: Date | string | null | undefined;
};

export class WorkItemProjectionFingerprintEntity {
  public readonly workItemId: WorkItemId;
  public readonly specId: string;
  public readonly fingerprint: string;
  public readonly canonicalContent: string;
  public readonly createdAt: Date | null | undefined;
  public readonly updatedAt: Date | null | undefined;

  constructor(props: WorkItemProjectionFingerprintProps) {
    const workItemId = props.workItemId.trim();
    const specId = props.specId.trim();
    const fingerprint = props.fingerprint.trim();

    if (!workItemId) {
      throw new CoreValidationError(
        "WorkItemProjectionFingerprint workItemId is required",
        "WORK_ITEM_PROJECTION_FINGERPRINT_WORK_ITEM_ID_REQUIRED",
      );
    }

    if (!specId) {
      throw new CoreValidationError(
        "WorkItemProjectionFingerprint specId is required",
        "WORK_ITEM_PROJECTION_FINGERPRINT_SPEC_ID_REQUIRED",
      );
    }

    if (!fingerprint) {
      throw new CoreValidationError(
        "WorkItemProjectionFingerprint fingerprint is required",
        "WORK_ITEM_PROJECTION_FINGERPRINT_REQUIRED",
      );
    }

    this.workItemId = parseWorkItemId(workItemId);
    this.specId = specId;
    this.fingerprint = fingerprint;
    this.canonicalContent = props.canonicalContent;
    this.createdAt = normalizeDate(props.createdAt);
    this.updatedAt = normalizeDate(props.updatedAt);
  }
}
