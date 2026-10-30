/**
 * `each`: a `next` target that starts one lane per item of an array. The
 * lane's nodes are wired in the pipeline's `flow` like any other; a lane ends
 * at a merge with `handle.partial(args)`, or at a terminal.
 */
import { AuthoringError } from "./errors";
import { registerEach } from "./registry";
import { refData } from "./refs";
import type { Placeholder, Ref } from "./ref-types";
import { captureSite } from "./source";
import type { EachOptions, EachTarget, Target } from "./types";

/** Starts one lane per element of `over`, each at the target `start` returns for its item. */
export function each<E>(
  over: Ref<readonly E[]>,
  options: EachOptions,
  start: (item: Placeholder<E>) => Target,
): EachTarget;
export function each<E>(
  over: Ref<readonly E[]>,
  start: (item: Placeholder<E>) => Target,
): EachTarget;
export function each(
  over: object,
  second: EachOptions | ((item: never) => Target),
  third?: (item: never) => Target,
): EachTarget {
  const data = refData(over);
  if (data === undefined) {
    throw new AuthoringError("each needs an array reference to iterate over");
  }
  const options = third === undefined ? {} : (second as EachOptions);
  const start = third ?? second;
  if (typeof start !== "function") {
    throw new AuthoringError(
      "each needs a start callback: (item) => step({ ... })",
    );
  }
  return registerEach(Object.freeze({ _tag: "pipeline_each" }), {
    over: data,
    maxConcurrency: options.maxConcurrency,
    toleratedFailures: options.toleratedFailures,
    start: start as (item: object) => object,
    site: captureSite(),
  }) as unknown as EachTarget;
}
