import { ActionError, type ActionErrorKind } from "@scarn/shared-core";
import { CliError, type CliErrorCode } from "./cli-error";
import { confirmAction } from "./confirm-action";
import { realBodySources, type BodySources } from "./read-body";

/**
 * What every safe action shares besides its API client: the confirmation
 * gate, where `--body` reads from, and how a refused action becomes a
 * {@link CliError}. Tests pass fakes for the first two.
 */

export interface ActionIo {
  /** `true` to proceed; see {@link confirmAction}. */
  confirm(message: string, yes: boolean): Promise<boolean>;
  body: BodySources;
}

export const realActionIo: ActionIo = {
  confirm: (message, yes) => confirmAction({ message, yes }),
  body: realBodySources,
};

const CODE_BY_ACTION_KIND: Record<ActionErrorKind, CliErrorCode> = {
  not_found: "action_not_found",
  forbidden: "action_forbidden",
  conflict: "action_conflict",
  rejected: "action_rejected",
  failed: "action_failed",
};

/** Runs `action`, rethrowing an {@link ActionError} as its {@link CliError}. */
export async function asCliAction<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof ActionError) {
      throw new CliError(CODE_BY_ACTION_KIND[error.kind], error.message, {
        cause: error,
      });
    }
    throw error;
  }
}

/** Validates `--attempt`: absent, or a positive whole number. */
export function parseAttempt(attempt: number | undefined): number | undefined {
  if (attempt !== undefined && (!Number.isInteger(attempt) || attempt < 1)) {
    throw new CliError(
      "invalid_usage",
      `--attempt must be a positive whole number, got ${String(attempt)}.`,
    );
  }
  return attempt;
}
