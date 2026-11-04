/**
 * Step handles: what `defineStep` and `codeStep` return.
 *
 * A handle is a function with the step's `StepDefinitionSpec` fields copied
 * onto it as enumerable properties, so it reads like the spec (`step.key`,
 * `step.inputSchemaJson`, ...) and can also be called. Calling a handle means
 * "go to this step with these args" in a pipeline; it records a target and
 * runs nothing.
 *
 * A function doesn't survive `JSON.stringify` or `structuredClone`, so
 * anything that copies or sends a step converts it with `toStepSpec` first.
 */
import { makeHandle, stepCall, stepNode } from "../../pipelines/handles";
import type { PipelineStep } from "../../pipelines/types";
import { BUILT_IN_ERRORS } from "../../contracts/pipeline-document/built-ins";
import type {
  StepConcurrency,
  StepDefinitionSpec,
  StepRetryEntry,
} from "./define-step";

export type StepHandle<
  TInput = unknown,
  TResult = unknown,
  TErrors extends string = string,
> = PipelineStep<TInput, TResult, TErrors> & Omit<StepDefinitionSpec, "errors">;

/**
 * Checks a step's declared error names: non-empty and unique, the same rules
 * the server applies on upsert.
 */
export function compileStepErrors(
  stepKey: string,
  errors: readonly string[] | undefined,
): string[] {
  const names = [...(errors ?? [])];
  const seen = new Set<string>();
  for (const name of names) {
    if (name.trim() === "") {
      throw new Error(`Step "${stepKey}": error names must not be empty.`);
    }
    if (seen.has(name)) {
      throw new Error(
        `Step "${stepKey}": error "${name}" is declared more than once.`,
      );
    }
    seen.add(name);
  }
  return names;
}

/**
 * Checks a step's `retry` policy the way the server does on upsert: each
 * entry names at least one built-in or declared error, and `maxAttempts`
 * is a positive integer.
 */
export function compileStepRetry(
  stepKey: string,
  retry: readonly StepRetryEntry[] | undefined,
  errors: readonly string[],
): StepRetryEntry[] {
  const known = new Set<string>([...BUILT_IN_ERRORS, ...errors]);
  return (retry ?? []).map((entry) => {
    if (entry.on.length === 0) {
      throw new Error(`Step "${stepKey}": each retry must name an error.`);
    }
    const unknown = entry.on.find((name) => !known.has(name));
    if (unknown !== undefined) {
      throw new Error(
        `Step "${stepKey}": retry names "${unknown}", which is neither a built-in error nor one the step declares.`,
      );
    }
    if (!Number.isInteger(entry.maxAttempts) || entry.maxAttempts <= 0) {
      throw new Error(
        `Step "${stepKey}": retry maxAttempts must be a positive integer.`,
      );
    }
    return { on: [...entry.on], maxAttempts: entry.maxAttempts };
  });
}

/** Checks a step's `maxTurns` the way the server does on upsert: a positive integer. */
export function compileStepMaxTurns(stepKey: string, maxTurns: number): number {
  if (!Number.isInteger(maxTurns) || maxTurns <= 0) {
    throw new Error(`Step "${stepKey}": maxTurns must be a positive integer.`);
  }
  return maxTurns;
}

/**
 * Checks a step's `concurrency` the way the server does on upsert: `max` an
 * integer ≥ 1 and `waiting` an integer ≥ 0.
 */
export function compileStepConcurrency(
  stepKey: string,
  concurrency: StepConcurrency,
): StepConcurrency {
  if (!Number.isInteger(concurrency.max) || concurrency.max < 1) {
    throw new Error(
      `Step "${stepKey}": concurrency max must be an integer of at least 1.`,
    );
  }
  if (!Number.isInteger(concurrency.waiting) || concurrency.waiting < 0) {
    throw new Error(
      `Step "${stepKey}": concurrency waiting must be a non-negative integer.`,
    );
  }
  return { max: concurrency.max, waiting: concurrency.waiting };
}

/**
 * Wraps a compiled spec in a callable handle. `name` is set with
 * `Object.defineProperty` because a function's own `name` is read-only. The
 * pipeline chain methods are non-enumerable, so they aren't spec fields.
 */
export function toStepHandle(spec: StepDefinitionSpec): StepHandle {
  const node = stepNode(spec);
  const call = stepCall(node);
  const { name, ...rest } = spec;
  Object.defineProperty(call, "name", {
    value: name,
    enumerable: true,
  });
  Object.assign(call, rest);
  return makeHandle(call, node) as unknown as StepHandle;
}

/**
 * The plain, serializable spec behind a step handle: its own enumerable
 * fields, in a new object. Accepts a plain spec too, and copies it.
 */
export function toStepSpec(step: StepDefinitionSpec): StepDefinitionSpec {
  return { ...step };
}
