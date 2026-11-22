import { connectorMcpCollisionMessage } from "@scarn/sdk/connectors";
import {
  describeBaseBranchEnvProblem,
  type BaseBranchEnvProblem,
} from "@scarn/sdk/repo-config";
import { CoreError } from "@scarn/core/lib/errors";

/**
 * A step definition names an environment the project doesn't have, or has
 * deleted (400). Distinct from the environment routes' 404
 * `ENVIRONMENT_NOT_FOUND`: here the request body is wrong, not the URL.
 */
export class StepEnvironmentNotFoundError extends CoreError {
  constructor(name: string) {
    super({
      code: "STEP_ENVIRONMENT_NOT_FOUND",
      message: `Environment "${name}" not found. Publish it before the steps that use it.`,
      status: 400,
      meta: { name },
    });
  }
}

/**
 * A step's `repo.baseBranch` has an `{{env.X}}` token its environment
 * doesn't declare, or that names a secret var (400).
 */
export class RepoBaseBranchInvalidError extends CoreError {
  constructor(problem: BaseBranchEnvProblem, environmentName?: string) {
    super({
      code: "REPO_BASE_BRANCH_INVALID",
      message: `repo.baseBranch: ${describeBaseBranchEnvProblem(problem)}${
        environmentName === undefined
          ? ""
          : ` (environment "${environmentName}")`
      }`,
      status: 400,
      meta: { token: problem.token, reason: problem.reason },
    });
  }
}

/** A step `mcps` key reuses a connector id of its named environment (400). */
export class StepEnvironmentConnectorCollisionError extends CoreError {
  constructor(name: string, collisions: readonly string[]) {
    super({
      code: "STEP_ENVIRONMENT_CONNECTOR_COLLISION",
      message: `Environment "${name}": ${connectorMcpCollisionMessage(collisions)}`,
      status: 400,
      meta: { name, collisions: [...collisions] },
    });
  }
}
