import { CoreValidationError } from "@scarn/core/lib/errors";
import type { StoredRuntimeConfig } from "@scarn/core/tasks/task-execution-config/contracts/task-execution-config-stored";
import type { StepDefinitionKind } from "./step-definition-entity";

/**
 * The step-kind rule that spans the step definition and its runtime: a `code`
 * step runs in a container. An `mcp_tool` step fits every runtime: its MCP
 * client runs in the worker, and only the server process lives in the
 * runtime. `null` means the runtime is not known here (the
 * repo default or a named environment); the worker checks it after resolution.
 * Everything the runtime can check on its own lives in
 * `TaskExecutionConfigEntity`.
 */
export const assertStepKindFitsRuntime = (
  kind: StepDefinitionKind,
  runtime: StoredRuntimeConfig | null,
): void => {
  if (kind === "code" && runtime?.kind === "host") {
    throw new CoreValidationError(
      "Step definition of kind 'code' cannot use environment runtime 'host'",
      "STEP_DEFINITION_CODE_RUNTIME_KIND_NOT_ALLOWED",
    );
  }
};
