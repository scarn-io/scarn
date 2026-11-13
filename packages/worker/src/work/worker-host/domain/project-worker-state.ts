import {
  WorkerAuthError,
  type WorkerAuthErrorReason,
} from "../../../auth/session/domain/worker-auth-error";
import { ProjectUnavailableError } from "../../task-run/contracts/project-unavailable-error";

/**
 * Where a project worker is in its life:
 * - `starting`: building its loop (worker client, push socket).
 * - `running`: its loop is claiming work.
 * - `draining`: told to stop; it claims nothing new and waits for its runs.
 * - `stopped`: not started yet, or drained.
 * - `error`: its loop stopped claiming because of {@link ProjectWorkerErrorReason};
 *   its runs keep going and it retries on a timer.
 */
export type ProjectWorkerStateName =
  "starting" | "running" | "draining" | "stopped" | "error";

/**
 * Why a project worker stopped claiming:
 * - `repo_missing`: the saved repo directory is gone.
 * - `project_unavailable`: the server answered 404 or 403 for the project.
 * - `auth_missing`, `auth_rejected`, `user_changed`: see `WorkerAuthError`.
 * - `crashed`: anything else the loop threw.
 */
export type ProjectWorkerErrorReason =
  "repo_missing" | "project_unavailable" | WorkerAuthErrorReason | "crashed";

export const FIRST_RETRY_DELAY_MS = 30_000;
export const MAX_RETRY_DELAY_MS = 300_000;

/** Raised before a loop starts when its repo directory no longer exists. */
export class RepoMissingError extends Error {
  override readonly name = "RepoMissingError";

  constructor(readonly repoDir: string) {
    super(`The repo directory ${repoDir} no longer exists.`);
  }
}

export function classifyProjectWorkerError(
  // eslint-disable-next-line local/no-unknown-parameter-type -- classifies whatever a loop threw
  error: unknown,
): ProjectWorkerErrorReason {
  if (error instanceof RepoMissingError) return "repo_missing";
  if (error instanceof ProjectUnavailableError) return "project_unavailable";
  if (error instanceof WorkerAuthError) return error.reason;
  return "crashed";
}

export function isAuthErrorReason(
  reason: ProjectWorkerErrorReason,
): reason is WorkerAuthErrorReason {
  return (
    reason === "auth_missing" ||
    reason === "auth_rejected" ||
    reason === "user_changed"
  );
}

/** 30s, 60s, 120s, 240s, then 5 minutes for every later attempt. */
export function retryDelayMs(attempt: number): number {
  return Math.min(FIRST_RETRY_DELAY_MS * 2 ** attempt, MAX_RETRY_DELAY_MS);
}
