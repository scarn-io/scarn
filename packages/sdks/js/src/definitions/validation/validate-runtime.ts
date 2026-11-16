import {
  environmentNameSchema,
  environmentRuntimeSchema,
} from "../../environment";
import { devcontainerConfigPathSchema } from "../../devcontainer-config-path";
import type { StepDefinitionSpec } from "../steps/define-step";
import type { DefinitionValidationIssue } from "./validation-issue";

/**
 * Validates inline runtimes in hand-built or generated specs and rejects host
 * execution for code steps, which require a container.
 */
export function checkRuntime(
  steps: readonly StepDefinitionSpec[],
): DefinitionValidationIssue[] {
  const issues: DefinitionValidationIssue[] = [];

  for (const step of steps) {
    if (step.environment?.kind === "named") {
      const result = environmentNameSchema.safeParse(step.environment.name);
      if (!result.success) {
        for (const issue of result.error.issues) {
          issues.push({
            check: "runtime",
            severity: "error",
            message: `Step "${step.key}" environment.name: ${issue.message}`,
          });
        }
      }
      continue;
    }
    if (step.environment?.kind !== "inline") continue;
    const runtime = step.environment.runtime;
    if (runtime === undefined) continue;
    if (runtime.kind !== "devcontainer" && "config" in runtime) {
      const config = devcontainerConfigPathSchema.safeParse(runtime.config);
      if (!config.success) {
        for (const issue of config.error.issues) {
          issues.push({
            check: "runtime",
            severity: "error",
            message: `Step "${step.key}" environment.runtime.config: ${issue.message}`,
          });
        }
      }
    }
    if (step.kind === "code" && runtime.kind === "host") {
      issues.push({
        check: "runtime",
        severity: "error",
        message: `Step "${step.key}": code steps need a container, so Runtime.host() is not supported for codeStep. Use Runtime.managed.<id>() or Runtime.devcontainer(), or drop the runtime.`,
      });
    }
    const result = environmentRuntimeSchema.safeParse(runtime);
    if (result.success) continue;
    for (const issue of result.error.issues) {
      issues.push({
        check: "runtime",
        severity: "error",
        message: `Step "${step.key}" environment.runtime${issue.path.length ? `.${issue.path.map(String).join(".")}` : ""}: ${issue.message}`,
      });
    }
  }

  return issues;
}
