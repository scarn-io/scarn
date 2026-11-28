import {
  artifactBundleEntryProblem,
  findArtifactFieldsWithProblems,
} from "../../contracts/artifacts";
import type { StepDefinitionSpec } from "../steps/define-step";
import type { DefinitionValidationIssue } from "./validation-issue";

/**
 * Check: artifact fields (`x-scarn-artifact`) never sit inside an array, as
 * v1 has no way to say which array item a submitted file belongs to; bundle
 * fields name a relative `.html` entry page; and every keyword is one this
 * SDK can read.
 */
export function checkArtifactFields(
  steps: readonly StepDefinitionSpec[],
): DefinitionValidationIssue[] {
  const issues: DefinitionValidationIssue[] = [];
  const issue = (message: string): void => {
    issues.push({ check: "artifact-field", severity: "error", message });
  };

  for (const step of steps) {
    const { fields, problems } = findArtifactFieldsWithProblems(
      step.resultSchemaJson ?? null,
    );
    for (const problem of problems) {
      issue(
        `Step "${step.key}" artifact field "${problem.path}": ${problem.message}.`,
      );
    }
    for (const field of fields) {
      if (field.bundle) {
        const entryProblem = artifactBundleEntryProblem(field.bundle.entry);
        if (entryProblem) {
          issue(
            `Step "${step.key}" bundle field "${field.path}": ${entryProblem}.`,
          );
        }
      }
      if (!field.inArray) continue;
      if (field.bundle) {
        issue(
          `Step "${step.key}" declares bundle field "${field.path}" inside an ` +
            `array. Bundle fields in arrays aren't supported; declare a fixed ` +
            `number of named bundle fields, or submit extra bundles without ` +
            `a field (undeclared bundles).`,
        );
        continue;
      }
      issue(
        `Step "${step.key}" declares artifact field "${field.path}" inside an ` +
          `array. Artifact fields in arrays aren't supported; declare a fixed ` +
          `number of named artifact fields instead.`,
      );
    }
  }

  return issues;
}
