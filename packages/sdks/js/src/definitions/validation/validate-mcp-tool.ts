import type { StepDefinitionSpec } from "../steps/define-step";
import type { DefinitionValidationIssue } from "./validation-issue";

/**
 * Checks the shape of `kind: "mcp_tool"` specs that weren't built by
 * `toolRef.step()`: a tool call naming the step's one MCP server, a result
 * schema, and no prompt, entrypoint or health checks. Other kinds may not
 * carry a tool call.
 */
export function checkMcpToolSteps(
  steps: readonly StepDefinitionSpec[],
): DefinitionValidationIssue[] {
  const issues: DefinitionValidationIssue[] = [];
  const push = (step: StepDefinitionSpec, problem: string): void => {
    issues.push({
      check: "mcp-tool",
      severity: "error",
      message: `Step "${step.key}": ${problem}`,
    });
  };

  for (const step of steps) {
    if (step.kind !== "mcp_tool") {
      if (step.toolCall !== undefined) {
        push(step, `only an mcp_tool step has a toolCall, not ${step.kind}.`);
      }
      continue;
    }
    const toolCall = step.toolCall;
    if (toolCall === undefined) {
      push(step, "an mcp_tool step needs a toolCall.");
      continue;
    }
    const servers = Object.keys(step.opencodeMcpJson ?? {});
    if (servers.length !== 1 || servers[0] !== toolCall.server) {
      push(
        step,
        `an mcp_tool step declares exactly one MCP server, the one its toolCall names ("${toolCall.server}"); it declares ${servers.length > 0 ? servers.map((server) => `"${server}"`).join(", ") : "none"}.`,
      );
    }
    if (toolCall.tool.trim() === "") {
      push(step, "toolCall.tool must not be empty.");
    }
    if (step.prompt !== null) {
      push(step, "an mcp_tool step has no prompt.");
    }
    if (step.entrypoint !== undefined || step.entrypointJson != null) {
      push(step, "an mcp_tool step has no entrypoint.");
    }
    if ((step.healthChecksJson ?? []).length > 0) {
      push(step, "an mcp_tool step runs no health checks.");
    }
    if (step.resultSchemaJson === null) {
      push(step, "an mcp_tool step needs a result schema.");
    }
  }

  return issues;
}
