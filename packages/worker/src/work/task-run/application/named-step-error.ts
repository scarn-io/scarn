import { BUILT_IN_ERRORS } from "@scarn/sdk/contracts/pipeline-document";
import { z } from "zod";

/**
 * A code step failed with a `StepError` whose name the step may fail with: a
 * built-in error or one of the step's declared `errors`.
 * `buildTaskRunFailurePayload` reports {@link NamedStepError.errorName} and
 * {@link NamedStepError.code} as the run's `errorJson`, so a pipeline's
 * `retry` or `catch` can match it.
 */
export class NamedStepError extends Error {
  readonly errorName: string;
  readonly code: string;

  constructor(errorName: string, code: string, message: string) {
    super(message);
    this.name = "NamedStepError";
    this.errorName = errorName;
    this.code = code;
  }
}

/** The code a named step error reports when the step gave none. */
export const NAMED_STEP_ERROR_DEFAULT_CODE = "SCARN_STEP_ERROR";

/**
 * Whether a code step may fail with `name`. `Scarn.All` only matches errors
 * in `retry` and `catch`, so no step fails with it.
 */
export function isAllowedStepErrorName(
  name: string,
  declaredErrors: readonly string[],
): boolean {
  if (name === "Scarn.All") return false;
  return (
    (BUILT_IN_ERRORS as readonly string[]).includes(name) ||
    declaredErrors.includes(name)
  );
}

const stepErrorRecordSchema = z.object({
  name: z.string().min(1),
  code: z.string().min(1).nullable().optional(),
  message: z.string(),
});

/**
 * The error a code step's non-zero exit throws. `errorFileText` is the
 * runner's `{ name, code, message }` record of a thrown `StepError`, or null
 * when `fn` threw something else or the runner failed before calling it. A
 * name the step may fail with gives a `NamedStepError`; any other name, or an
 * unreadable record, gives a plain `Error` (reported as `Scarn.StepFailed`),
 * and `onLog` hears why.
 */
export function codeStepFailure(input: {
  message: string;
  errorFileText: string | null;
  declaredErrors: readonly string[];
  stepKey: string;
  onLog?:
    ((message: string, details: Record<string, unknown>) => void) | undefined;
}): Error {
  if (input.errorFileText === null) return new Error(input.message);
  const record = stepErrorRecordSchema.safeParse(
    parseJsonOrNull(input.errorFileText),
  );
  if (!record.success) {
    input.onLog?.(
      "Code step error record is unreadable; reporting Scarn.StepFailed",
      { stepKey: input.stepKey },
    );
    return new Error(input.message);
  }
  const { name, code } = record.data;
  if (!isAllowedStepErrorName(name, input.declaredErrors)) {
    input.onLog?.(
      `Code step threw StepError "${name}", which is neither a built-in error nor declared in the step's errors; reporting Scarn.StepFailed`,
      {
        stepKey: input.stepKey,
        errorName: name,
        declaredErrors: [...input.declaredErrors],
      },
    );
    return new Error(input.message);
  }
  return new NamedStepError(
    name,
    code ?? NAMED_STEP_ERROR_DEFAULT_CODE,
    input.message,
  );
}

function parseJsonOrNull(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
