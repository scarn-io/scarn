import { validate as isUuid, version as uuidVersion, v7 as uuidv7 } from "uuid";
import { CoreValidationError } from "@scarn/core/lib/errors";

export type WorkItemBlockId = string & {
  readonly __brand: "WorkItemBlockId";
};

export const isWorkItemBlockId = (value: string): value is WorkItemBlockId =>
  isUuid(value) && uuidVersion(value) === 7;

export const parseWorkItemBlockId = (value: string): WorkItemBlockId => {
  const normalizedValue = value.trim();

  if (!isWorkItemBlockId(normalizedValue)) {
    throw new CoreValidationError(
      `Work item block id must be a UUID v7: ${value}`,
      "INVALID_WORK_ITEM_BLOCK_ID",
    );
  }

  return normalizedValue;
};

export const createWorkItemBlockId = (): WorkItemBlockId =>
  parseWorkItemBlockId(uuidv7());
