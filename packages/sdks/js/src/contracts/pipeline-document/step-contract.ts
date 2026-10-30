/** What a pipeline document needs to know about the steps it uses. */
import type { JsonSchema } from "./json";

/** What the validator needs to know about a step definition. */
export interface StepContract {
  inputSchema: JsonSchema;
  /** null: a conversation step, whose result is `CONVERSATION_RESULT_SCHEMA`. */
  resultSchema: JsonSchema | null;
  /** Error names the step declares, which `retry.on` and `catch.on` may use. */
  errors: readonly string[];
}

export type StepCatalog = Readonly<Record<string, StepContract>>;
