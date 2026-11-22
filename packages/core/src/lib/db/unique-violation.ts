const UNIQUE_VIOLATION_CODE = "23505";

const hasCode = (value: object, code: string): boolean =>
  "code" in value && value.code === code;

/**
 * Whether `error` is a Postgres unique-constraint violation, either raised
 * directly by the driver or wrapped by Drizzle (`DrizzleQueryError.cause`).
 */
export const isUniqueViolation = (error: Error | object | null): boolean => {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  if (hasCode(error, UNIQUE_VIOLATION_CODE)) {
    return true;
  }
  const cause = "cause" in error ? error.cause : undefined;
  return (
    typeof cause === "object" &&
    cause !== null &&
    hasCode(cause, UNIQUE_VIOLATION_CODE)
  );
};
