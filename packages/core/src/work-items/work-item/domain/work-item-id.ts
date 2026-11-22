import { validate as isUuid, version as uuidVersion, v7 as uuidv7 } from "uuid";
import { CoreValidationError } from "@scarn/core/lib/errors";

export type WorkItemId = string & { readonly __brand: "WorkItemId" };

export const isWorkItemId = (value: string): value is WorkItemId =>
  isUuid(value) && uuidVersion(value) === 7;

export const parseWorkItemId = (value: string): WorkItemId => {
  const normalizedValue = value.trim();

  if (!isWorkItemId(normalizedValue)) {
    throw new CoreValidationError(
      `Work item id must be a UUID v7: ${value}`,
      "INVALID_WORK_ITEM_ID",
    );
  }

  return normalizedValue;
};

export const createWorkItemId = (): WorkItemId => parseWorkItemId(uuidv7());
