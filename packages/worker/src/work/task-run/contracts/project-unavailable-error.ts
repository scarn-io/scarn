/**
 * Raised by the worker API client when the server says the project is gone
 * (404 `PROJECT_NOT_FOUND`) or the worker's user may not work on it (403
 * `PROJECT_FORBIDDEN`). Unlike a `WorkerAuthError`, signing in again does not
 * help; the project itself has to come back or be shared again.
 */
export class ProjectUnavailableError extends Error {
  override readonly name = "ProjectUnavailableError";

  constructor(
    readonly status: 403 | 404,
    message: string,
  ) {
    super(message);
  }
}

const PROJECT_UNAVAILABLE_CODES: Record<string, 403 | 404> = {
  PROJECT_NOT_FOUND: 404,
  PROJECT_FORBIDDEN: 403,
};

/** The status a `{ code }` API error body maps to, when it means the project is unavailable. */
export function projectUnavailableStatus(
  status: number,
  code: string | undefined,
): 403 | 404 | null {
  if (code === undefined) return null;
  const expected = PROJECT_UNAVAILABLE_CODES[code];
  return expected === status ? expected : null;
}
