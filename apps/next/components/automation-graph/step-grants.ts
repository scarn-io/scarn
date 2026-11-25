import type { StepDefinitionContract } from "@scarn/api/frontend-contracts";
import type { Grant } from "@scarn/sdk/definitions/steps";

/** Each step key's grants, from its highest active version. */
export function stepGrantsByKey(
  definitions: readonly StepDefinitionContract[],
): ReadonlyMap<string, readonly Grant[]> {
  const latest = new Map<string, StepDefinitionContract>();
  for (const definition of definitions) {
    if (definition.status !== "active") continue;
    const current = latest.get(definition.key);
    if (!current || definition.version > current.version) {
      latest.set(definition.key, definition);
    }
  }
  return new Map(
    [...latest].map(([key, definition]) => [key, definition.grants]),
  );
}
