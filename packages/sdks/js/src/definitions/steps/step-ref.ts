import type { JsonSchema } from "../../contracts/pipeline-document";

/**
 * What a pipeline needs to know about a step: its key, its input and result
 * schemas, the error names it declares, and its input and result types.
 *
 * Every `defineStep` / `codeStep` handle satisfies this structurally. It is the
 * only step type the pipeline authoring SDK depends on, so the rest of a
 * step's definition (prompt, runtime, MCPs, ...) can change without touching
 * pipelines. `__input` and `__result` are phantom fields: they exist only in
 * the type, never at runtime.
 */
export type StepRef<TInput, TResult, TErrors extends string = string> = {
  key: string;
  inputSchemaJson: JsonSchema | null;
  resultSchemaJson: JsonSchema | null;
  errors: readonly TErrors[];
  readonly __input: TInput;
  readonly __result: TResult;
};
