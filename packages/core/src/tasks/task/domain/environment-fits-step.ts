import {
  connectorMcpCollisionMessage,
  findConnectorMcpCollisions,
} from "@scarn/sdk/connectors";
import {
  describeBaseBranchEnvProblem,
  findBaseBranchEnvProblems,
} from "@scarn/sdk/repo-config";
import type { EnvironmentContent } from "@scarn/core/common/contracts/environment";
import { CoreValidationError } from "@scarn/core/lib/errors";
import type { TaskKind } from "@scarn/core/tasks/task-run/domain/task-run-entity";
import type { TaskExecutionConfigContent } from "@scarn/core/tasks/task-execution-config/contracts/task-execution-config-stored";

export const ENVIRONMENT_OVERRIDE_INCOMPATIBLE =
  "ENVIRONMENT_OVERRIDE_INCOMPATIBLE";

const incompatible = (name: string, reason: string, detail: string) =>
  new CoreValidationError(
    `Environment "${name}" doesn't fit this step: ${detail}`,
    ENVIRONMENT_OVERRIDE_INCOMPATIBLE,
    { name, reason },
  );

/**
 * Decision 4: whether the named environment `name` (one version's
 * `content`) can replace a step's environment. A `code` step can't run on a
 * `host` runtime, the step's `mcps` keys can't reuse the environment's
 * connector ids, and every `{{env.X}}` in the step's `repo.baseBranch` must
 * be a non-secret var of the environment. Returns the first problem as a
 * 422 `ENVIRONMENT_OVERRIDE_INCOMPATIBLE`, or `null` when it fits. Checked
 * when the Task is created and again at startup against the pinned version.
 */
export const environmentFitsStep = ({
  name,
  content,
  stepKind,
  stepConfig,
}: {
  name: string;
  content: EnvironmentContent;
  stepKind: TaskKind;
  stepConfig: Pick<TaskExecutionConfigContent, "git" | "mcp"> | null;
}): CoreValidationError | null => {
  if (stepKind === "code" && content.runtime?.kind === "host") {
    return incompatible(
      name,
      "code_step_host_runtime",
      "a code step can't run on a host runtime",
    );
  }
  const collisions = findConnectorMcpCollisions(
    content.connectors ?? [],
    Object.keys(stepConfig?.mcp ?? {}),
  );
  if (collisions.length > 0) {
    return incompatible(
      name,
      "connector_mcp_collision",
      connectorMcpCollisionMessage(collisions),
    );
  }
  const baseBranch = stepConfig?.git?.baseBranch ?? null;
  if (baseBranch !== null) {
    const [problem] = findBaseBranchEnvProblems(baseBranch, content.vars ?? []);
    if (problem !== undefined) {
      return incompatible(
        name,
        "base_branch_env",
        `repo.baseBranch: ${describeBaseBranchEnvProblem(problem)}`,
      );
    }
  }
  return null;
};
