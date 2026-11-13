/**
 * Why a worker can no longer act for its user:
 * - `auth_missing`: no profile for the base URL in `auth.jsonc`.
 * - `auth_rejected`: the server answered 401 or 403.
 * - `user_changed`: the profile now belongs to a different user than the one
 *   the worker started as.
 */
export type WorkerAuthErrorReason =
  "auth_missing" | "auth_rejected" | "user_changed";

/** Raised by the worker API client when its credentials stop being usable. */
export class WorkerAuthError extends Error {
  override readonly name = "WorkerAuthError";

  constructor(
    readonly reason: WorkerAuthErrorReason,
    message: string,
  ) {
    super(message);
  }
}
