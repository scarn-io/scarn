type ProblemDetails = {
  status: number;
  detail?: string;
  code?: unknown;
  meta?: unknown;
};

// eslint-disable-next-line local/no-unknown-parameter-type
function parseProblemDetails(input: unknown): ProblemDetails | null {
  if (input === null || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;
  // Handle eden error wrapper: { status, value: <problem details> }
  const wrapped = obj["value"];
  const pd = (
    wrapped !== null && typeof wrapped === "object" ? wrapped : obj
  ) as Record<string, unknown>;
  if (typeof pd["status"] !== "number") return null;
  return pd as ProblemDetails;
}

// eslint-disable-next-line local/no-unknown-parameter-type
export function parseApiError(error: unknown, fallback: string): string {
  const details = parseProblemDetails(error);
  if (!details) return fallback;

  const { status, detail } = details;

  if (status === 401)
    return "You're not logged in. Refresh the page and try again.";
  if (status === 403) return "You don't have permission to do this.";
  if (status === 400 || status === 409 || status === 422)
    return detail ?? fallback;
  if (status === 502)
    return "Could not reach the external service. Check your connection settings.";
  if (status >= 500) return "Something went wrong. Try again.";

  return fallback;
}

/** The HTTP `status` from a problem-details error (or its Eden wrapper), if any. */
// eslint-disable-next-line local/no-unknown-parameter-type
export function apiErrorStatus(error: unknown): number | undefined {
  return parseProblemDetails(error)?.status;
}

/** The `code` from a problem-details error (or its Eden wrapper), if any. */
// eslint-disable-next-line local/no-unknown-parameter-type
export function apiErrorCode(error: unknown): string | undefined {
  const code = parseProblemDetails(error)?.code;
  return typeof code === "string" ? code : undefined;
}

/** The structured `meta` a validation error carries (or its Eden wrapper), if any. */
export function apiErrorMeta(
  // eslint-disable-next-line local/no-unknown-parameter-type
  error: unknown,
): Record<string, unknown> | undefined {
  const meta = parseProblemDetails(error)?.meta;
  return meta !== null && typeof meta === "object" && !Array.isArray(meta)
    ? (meta as Record<string, unknown>)
    : undefined;
}
