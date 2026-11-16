import { repoConfigInputSchema } from "../../repo-config";
import type { StepDefinitionSpec } from "../steps/define-step";
import type { DefinitionValidationIssue } from "./validation-issue";

/**
 * Check: a step's `repo` satisfies `repoConfigInputSchema` (shape, commit
 * message length, single line and allowed template tokens). Every runtime
 * accepts `readOnly` and `readWrite`. This catches hand-built or generated
 * specs that bypass the authoring helpers.
 */
export function checkRepo(
  steps: readonly StepDefinitionSpec[],
): DefinitionValidationIssue[] {
  const issues: DefinitionValidationIssue[] = [];

  for (const step of steps) {
    if (!step.repo) continue;
    const where = `Step "${step.key}" repo`;

    const parsed = repoConfigInputSchema.safeParse(step.repo);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = issue.path.map(String).join(".");
        issues.push({
          check: "repo",
          severity: "error",
          message: `${where}${field ? ` ${field}` : ""}: ${issue.message}`,
        });
      }
    }
  }

  return issues;
}
