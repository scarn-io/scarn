// Spec builders shared by the `validateDefinitionSpecs` suites.
//
// The specs are hand-built rather than produced by `defineStep` on purpose:
// most of these fixtures are exactly the mistakes the builders refuse to make.
// The point of the runtime validator is the callers that bypass them — JS
// files, generated files, hand-edited files — so the tests have to bypass them
// too.

import { z } from "zod";
import type { StepDefinitionSpec } from "../src/definitions/steps";

export function stepSpec(
  key: string,
  result: z.ZodType | null,
): StepDefinitionSpec {
  return {
    key,
    name: key,
    description: null,
    version: 1,
    kind: "user_defined",
    status: "active",
    prompt: null,
    inputSchemaJson: null,
    resultSchemaJson: result ? z.toJSONSchema(result) : null,
    opencodeMcpJson: null,
    healthChecksJson: null,
  };
}

/** `stepSpec`, but with arbitrary field overrides (e.g. mcpServers, healthChecks). */
export function stepSpecWithOverrides(
  key: string,
  overrides: Partial<StepDefinitionSpec> = {},
): StepDefinitionSpec {
  return { ...stepSpec(key, null), ...overrides };
}
