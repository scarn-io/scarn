/**
 * The errors a code step's `context.workItems` calls throw. Each is a
 * `StepError` with a built-in name, so an uncaught one fails the Task in a way
 * a pipeline's `retry` and `catch` can match; `code` tells them apart.
 */
import { StepError } from "./step-error";

/**
 * The step's grants or the claiming user's permissions don't cover the call,
 * and nothing was written. `apiCode` is `WORK_ITEM_GRANT_MISSING` (the
 * step's features) or `PROJECT_FORBIDDEN` (the user who started the worker).
 */
export class WorkItemsRefusedError extends StepError<"Scarn.StepFailed"> {
  readonly apiCode: string;
  /** How many items were refused, when the server says. */
  readonly refused: number | undefined;

  constructor(message: string, apiCode: string, refused?: number) {
    super("Scarn.StepFailed", message, { code: `SCARN_${apiCode}` });
    this.apiCode = apiCode;
    this.refused = refused;
  }
}

/** The items or arguments are invalid or too large; nothing was written. */
export class WorkItemsInvalidError extends StepError<"Scarn.ArgsError"> {
  constructor(message: string) {
    super("Scarn.ArgsError", message, { code: "SCARN_WORK_ITEMS_INVALID" });
  }
}

export type WorkItemsUnavailableReason =
  /** No bridge env: the step isn't running inside a Scarn run. */
  | "no_bridge"
  /** The bridge couldn't be reached, rejected the token or answered badly. */
  | "bridge";

/** The worker's bridge, or the API behind it, couldn't serve the call. */
export class WorkItemsUnavailableError extends StepError<"Scarn.StepFailed"> {
  readonly reason: WorkItemsUnavailableReason;
  readonly detail: string;

  constructor(
    message: string,
    reason: WorkItemsUnavailableReason,
    detail: string,
  ) {
    super("Scarn.StepFailed", message, {
      code: "SCARN_WORK_ITEMS_UNAVAILABLE",
    });
    this.reason = reason;
    this.detail = detail;
  }
}
