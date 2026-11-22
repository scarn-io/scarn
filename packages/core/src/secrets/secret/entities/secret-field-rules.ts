import { z } from "zod";
import { CoreValidationError } from "@scarn/core/lib/errors";

const emailSchema = z.string().trim().toLowerCase().check(z.email());

/** Trims and lowercases an Atlassian account email, or throws `SECRET_EMAIL_INVALID`. */
export const normalizeSecretEmail = (email: string, label: string): string => {
  const parsed = emailSchema.safeParse(email);
  if (!parsed.success) {
    throw new CoreValidationError(
      `${label} email must be a valid email address`,
      "SECRET_EMAIL_INVALID",
    );
  }
  return parsed.data;
};

/** Throws `SECRET_EXPIRY_IN_PAST` unless `expiresAt` is after `now`. */
export const assertSecretExpiryInFuture = (
  expiresAt: Date,
  now: Date,
  label: string,
): void => {
  if (expiresAt.getTime() <= now.getTime()) {
    throw new CoreValidationError(
      `${label} expiry must be in the future`,
      "SECRET_EXPIRY_IN_PAST",
    );
  }
};
