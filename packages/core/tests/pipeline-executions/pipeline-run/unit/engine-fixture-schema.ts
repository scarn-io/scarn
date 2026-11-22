import type { JsonSchema } from "@scarn/sdk/contracts/pipeline-document";

/** A closed object schema whose properties are all required unless listed. */
export const obj = (
  title: string,
  properties: Record<string, JsonSchema>,
  required: string[] = Object.keys(properties),
): JsonSchema => ({
  title,
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
