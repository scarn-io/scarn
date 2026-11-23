import { assertNever } from "../../../common/assert-never";
import type { TaskKind } from "../contracts/task-run-contracts";

/**
 * Whether a task of this kind prompts an OpenCode agent, and so needs the
 * OpenCode server (and everything that exists only to support it) launched.
 * An exhaustive switch, not `kind !== "code"`: adding a kind fails typecheck
 * here until its author decides.
 */
export function taskKindUsesAgent(kind: TaskKind): boolean {
  switch (kind) {
    case "agent":
      return true;
    case "code":
    case "mcp_tool":
      return false;
    default:
      return assertNever(kind);
  }
}

/**
 * Whether a launch of this kind resolves the step's MCP servers (refs,
 * connectors, managed relay, the env they need). An agent hands them to
 * OpenCode; an `mcp_tool` task calls one of them itself; a code step calls
 * its servers through the MCP bridge (a step without servers resolves none).
 */
export function taskKindResolvesMcpServers(kind: TaskKind): boolean {
  switch (kind) {
    case "agent":
    case "mcp_tool":
    case "code":
      return true;
    default:
      return assertNever(kind);
  }
}

/**
 * Whether a managed runtime of this kind installs the pipeline-builder
 * dependencies: only a code step runs pipeline-builder code.
 */
export function taskKindInstallsPipelineBuilder(kind: TaskKind): boolean {
  switch (kind) {
    case "code":
      return true;
    case "agent":
    case "mcp_tool":
      return false;
    default:
      return assertNever(kind);
  }
}
