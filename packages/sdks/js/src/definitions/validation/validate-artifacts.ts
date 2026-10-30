import { findArtifactFields } from "../../contracts/artifacts";
import type { StepDefinitionSpec } from "../steps/define-step";
import type { DefinitionValidationIssue } from "./validation-issue";

/**
 * Check: artifact fields (`x-scarn-artifact`) never sit inside an array.
 * v1 has no way to say which array item a submitted file belongs to.
 */
export function checkArtifactFields(
  steps: readonly StepDefinitionSpec[],
): DefinitionValidationIssue[] {
  const issues: DefinitionValidationIssue[] = [];

  for (const step of steps) {
    for (const field of findArtifactFields(step.resultSchemaJson ?? null)) {
      if (!field.inArray) continue;
      issues.push({
        check: "artifact-field",
        severity: "error",
        message:
          `Step "${step.key}" declares artifact field "${field.path}" inside an ` +
          `array. Artifact fields in arrays aren't supported; declare a fixed ` +
          `number of named artifact fields instead.`,
      });
    }
  }

  return issues;
}
