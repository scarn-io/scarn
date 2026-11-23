/**
 * `StepError`: an error a code step throws with a pipeline error name, so a
 * pipeline can `retry` or `catch` it by that name. The SDK's own errors (the
 * MCP errors of `context.mcp`) extend it with built-in names; authors throw
 * it with the names their step declares in `errors`.
 *
 * Errors are recognised by the `Symbol.for("scarn.stepError")` brand rather
 * than `instanceof`, so one thrown from a different copy of the SDK (the
 * step's module bundle versus the runner) still counts.
 */
export const STEP_ERROR_BRAND: unique symbol = Symbol.for("scarn.stepError");

export type StepErrorOptions = {
  /** A machine-readable detail below the name, such as a reason. */
  readonly code?: string;
  readonly cause?: unknown;
};

export class StepError<TName extends string = string> extends Error {
  readonly [STEP_ERROR_BRAND] = true;
  declare readonly name: TName;
  readonly code: string | undefined;

  constructor(name: TName, message: string, options: StepErrorOptions = {}) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    Object.defineProperty(this, "name", {
      value: name,
      enumerable: false,
      configurable: true,
      writable: false,
    });
    this.code = options.code;
  }
}

/**
 * Throws a `StepError`. A code step's `context.fail` is this function, typed
 * to accept only the built-in names and the names the step declares in
 * `errors`; pass it as `fail` when calling a step's `fn` from a unit test.
 */
export function failStep(
  name: string,
  message: string,
  options?: StepErrorOptions,
): never {
  throw new StepError(name, message, options);
}

/** True for any `StepError`, including one from another copy of the SDK. */
// eslint-disable-next-line local/no-unknown-parameter-type -- runtime guard over anything thrown by step code
export function isStepError(value: unknown): value is StepError {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { [STEP_ERROR_BRAND]?: unknown })[STEP_ERROR_BRAND] === true &&
    typeof (value as { name?: unknown }).name === "string"
  );
}
