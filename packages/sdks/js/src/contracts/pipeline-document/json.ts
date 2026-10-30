/**
 * JSON value and JSON Schema types shared across the package, plus small
 * helpers for JSON pointers and structural equality.
 */
export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

export interface JsonSchemaObject {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: JsonSchema;
  items?: JsonSchema;
  prefixItems?: JsonSchema[];
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  enum?: JsonValue[];
  const?: JsonValue;
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
  definitions?: Record<string, JsonSchema>;
  title?: string;
  description?: string;
  format?: string;
  [key: string]: unknown;
}

export type JsonSchema = boolean | JsonSchemaObject;

export function isJsonObject(
  value: JsonValue | undefined,
): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapePointerSegment(segment: string | number): string {
  return String(segment).replaceAll("~", "~0").replaceAll("/", "~1");
}

/** Builds an RFC 6901 JSON pointer such as `/nodes/fix/next/routes/1/args/plan`. */
export function jsonPointer(segments: readonly (string | number)[]): string {
  return segments
    .map((segment) => `/${escapePointerSegment(segment)}`)
    .join("");
}

export function deepEqual(
  left: JsonValue | undefined,
  right: JsonValue | undefined,
): boolean {
  if (left === right) {
    return true;
  }
  if (Array.isArray(left)) {
    return (
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => deepEqual(item, right[index]))
    );
  }
  if (isJsonObject(left) && isJsonObject(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every(
        (key) => Object.hasOwn(right, key) && deepEqual(left[key], right[key]),
      )
    );
  }
  return false;
}
