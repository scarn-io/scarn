/**
 * The Task error of a launch whose managed connection wasn't serving when the
 * run registered it (decision 13): the run fails before anything starts, and
 * the failure skips automatic retry because a retry would only fail the same
 * way until a project admin reconnects.
 */
import { joinConnectionLabels } from "./managed-connection-labels";
import { MANAGED_NEW_ATTEMPT_GUIDANCE } from "./managed-seal-authority";

export const MANAGED_CONNECTION_NOT_READY_ERROR = "ManagedConnectionNotReady";

/**
 * The named error (see `namedRunError`) of a launch that failed as not ready,
 * naming the affected connections by label; without any, it says "a managed
 * connection".
 */
export const managedConnectionNotReadyError = (
  labels: readonly (string | null | undefined)[],
): {
  name: string;
  message: string;
} => {
  const joined = joinConnectionLabels(labels);
  const notReady =
    joined === null
      ? "A managed connection this run uses isn't ready, so the run didn't start; a project admin must reconnect it in project settings."
      : joined.count === 1
        ? `The project's ${joined.text} connection isn't ready, so the run didn't start; a project admin must reconnect it in project settings.`
        : `The project's ${joined.text} connections aren't ready, so the run didn't start; a project admin must reconnect them in project settings.`;
  return {
    name: MANAGED_CONNECTION_NOT_READY_ERROR,
    message: `${notReady} ${MANAGED_NEW_ATTEMPT_GUIDANCE}`,
  };
};

/** Whether a run's named error is `ManagedConnectionNotReady`. */
export const isManagedConnectionNotReady = (error: { name: string }): boolean =>
  error.name === MANAGED_CONNECTION_NOT_READY_ERROR;
