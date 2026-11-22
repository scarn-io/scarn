import { validate as isUuid, version as uuidVersion, v7 as uuidv7 } from "uuid";
import { CoreValidationError } from "@scarn/core/lib/errors";

export type WorkItemCommentId = string & {
  readonly __brand: "WorkItemCommentId";
};

export const isWorkItemCommentId = (value: string): value is WorkItemCommentId =>
  isUuid(value) && uuidVersion(value) === 7;

export const parseWorkItemCommentId = (value: string): WorkItemCommentId => {
  const normalizedValue = value.trim();

  if (!isWorkItemCommentId(normalizedValue)) {
    throw new CoreValidationError(
      `Work item comment id must be a UUID v7: ${value}`,
      "INVALID_WORK_ITEM_COMMENT_ID",
    );
  }

  return normalizedValue;
};

export const createWorkItemCommentId = (): WorkItemCommentId =>
  parseWorkItemCommentId(uuidv7());
