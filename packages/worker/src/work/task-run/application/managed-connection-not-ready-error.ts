/** Error code the server answers a launch registration with when a managed connection isn't serving. */
export const MANAGED_CONNECTION_NOT_READY_ERROR_CODE =
  "MANAGED_CONNECTION_NOT_READY";

/**
 * The Task error name of a launch whose managed connection wasn't ready; the
 * server never retries it.
 */
export const MANAGED_CONNECTION_NOT_READY_ERROR_NAME =
  "ManagedConnectionNotReady";

/** Which entry's connection wasn't ready, and why, from the server's 409. */
export type ManagedConnectionNotReadyCause = {
  key: string | null;
  state: string | null;
  reasonCode: string | null;
};

const NEW_ATTEMPT_GUIDANCE =
  "It isn't retried automatically: start a new attempt explicitly with Retry in the app, `scarn tasks retry <taskId>`, or `scarn runs rerun <runId> --step <key>` for a pipeline step.";

function stringField(
  meta: Readonly<Record<string, unknown>> | undefined,
  field: string,
): string | null {
  const value = meta?.[field];
  return typeof value === "string" ? value : null;
}

function nonEmptyField(
  meta: Readonly<Record<string, unknown>> | undefined,
  field: string,
): string | null {
  const value = stringField(meta, field);
  return value === "" ? null : value;
}

/**
 * Names the connection by its `label` from the server's 409, else by the
 * `connection` name `auth` used (the project may not have it), else
 * generically.
 */
function notReadyMessage(
  meta: Readonly<Record<string, unknown>> | undefined,
): string {
  const label = nonEmptyField(meta, "label");
  if (label !== null) {
    return `The project's ${label} connection isn't ready, so the run didn't start; a project admin must reconnect it in project settings. ${NEW_ATTEMPT_GUIDANCE}`;
  }
  const name = nonEmptyField(meta, "connection");
  if (name !== null) {
    return `The project's "${name}" connection isn't ready or doesn't exist, so the run didn't start; a project admin must connect it in project settings. ${NEW_ATTEMPT_GUIDANCE}`;
  }
  return `A managed connection this run uses isn't ready, so the run didn't start; a project admin must reconnect it in project settings. ${NEW_ATTEMPT_GUIDANCE}`;
}

/**
 * Thrown before OpenCode starts when registering the run's managed launch
 * finds a connection that isn't serving. The run is reported as failed with
 * {@link MANAGED_CONNECTION_NOT_READY_ERROR_NAME}.
 */
export class ManagedConnectionNotReadyError extends Error {
  readonly details: ManagedConnectionNotReadyCause;

  constructor(meta?: Readonly<Record<string, unknown>>) {
    super(notReadyMessage(meta));
    this.name = "ManagedConnectionNotReadyError";
    this.details = {
      key: stringField(meta, "key"),
      state: stringField(meta, "state"),
      reasonCode: stringField(meta, "reasonCode"),
    };
  }
}
