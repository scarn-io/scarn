import { validate as isUuid, version as uuidVersion, v7 as uuidv7 } from "uuid";
import { CoreValidationError } from "@scarn/core/lib/errors";
import z from "zod";

export type UuidV7 = string & { readonly __brand: "uuidv7" };

export const isUuidV7 = (value: string): value is UuidV7 =>
  isUuid(value) && uuidVersion(value) === 7;

export const parseUuidV7 = (value: string): UuidV7 => {
  const normalizedValue = value.trim();

  if (!isUuidV7(normalizedValue)) {
    throw new CoreValidationError(
      `Id must be a UUID v7: ${value}`,
      "INVALID_UUID_V7",
    );
  }

  return normalizedValue;
};

export const createUuidV7 = (): UuidV7 => parseUuidV7(uuidv7());

export const uuidV7Schema = z.string().trim().refine(isUuidV7, {
  message: "Id must be a UUID v7",
});
