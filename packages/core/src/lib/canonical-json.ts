import type { AnyJsonValue } from "@scarn/core/common/contracts/json";

const compareCodePoints = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;

/**
 * Serializes `value` with object keys sorted at every depth, so two values
 * that are equal as JSON produce the same string regardless of key order.
 * Array order is significant. `undefined` properties are dropped, as in
 * `JSON.stringify`.
 */
export const canonicalJson = (value: object | null): string =>
  JSON.stringify(value, (_key, nested: AnyJsonValue) =>
    nested !== null && typeof nested === "object" && !Array.isArray(nested)
      ? Object.fromEntries(
          Object.entries(nested).sort(([left], [right]) =>
            compareCodePoints(left, right),
          ),
        )
      : nested,
  );
