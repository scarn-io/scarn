import { findConnectorMcpCollisions } from "@scarn/sdk/connectors";
import {
  findBaseBranchEnvProblems,
  type BaseBranchEnvVar,
} from "@scarn/sdk/repo-config";
import { parseUuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import {
  type ResolveTaskExecutionConfigDeps,
  resolveTaskExecutionConfig,
} from "@scarn/core/tasks/task-execution-config/application/resolve-task-execution-config";
import type { TaskExecutionConfigEntity } from "@scarn/core/tasks/task-execution-config/domain/task-execution-config-entity";
import type { EnvironmentRepo } from "@scarn/core/pipeline-definitions/environment/application/environment-repo";
import type { CreateStepDefinitionInput } from "../contracts/step-definition-contracts";
import { assertStepKindFitsRuntime } from "../domain/assert-step-kind-fits-runtime";
import { assertToolCallFitsMcpServers } from "../domain/step-definition-entity";
import {
  RepoBaseBranchInvalidError,
  StepEnvironmentConnectorCollisionError,
  StepEnvironmentNotFoundError,
} from "../domain/step-named-environment-errors";

export type ResolveStepDefinitionTaskExecutionConfigDeps =
  ResolveTaskExecutionConfigDeps & {
    environmentRepo: Pick<EnvironmentRepo, "findLiveWithLatestVersionByName">;
  };

/**
 * Checks a named environment against the project's latest version of it:
 * the name must exist and not be deleted, and the step's `mcps` keys must
 * not reuse its connector ids (decision 8), and `repo.baseBranch` may only
 * read its declared, non-secret vars.
 */
const assertNamedEnvironmentFits = async (
  input: CreateStepDefinitionInput,
  name: string,
  environmentRepo: ResolveStepDefinitionTaskExecutionConfigDeps["environmentRepo"],
  dbExecutor: DbExecutor,
): Promise<void> => {
  const found = await environmentRepo.findLiveWithLatestVersionByName(
    parseUuidV7(input.projectId),
    name,
    dbExecutor,
  );
  if (!found) throw new StepEnvironmentNotFoundError(name);
  const collisions = findConnectorMcpCollisions(
    found.latestVersion.content.connectors ?? [],
    Object.keys(input.opencodeMcpJson ?? {}),
  );
  if (collisions.length > 0) {
    throw new StepEnvironmentConnectorCollisionError(name, collisions);
  }
  assertBaseBranchFitsVars(input, found.latestVersion.content.vars ?? [], name);
};

/**
 * Every `{{env.X}}` token in `repo.baseBranch` must name a declared,
 * non-secret var of the step's environment.
 */
const assertBaseBranchFitsVars = (
  input: CreateStepDefinitionInput,
  vars: readonly BaseBranchEnvVar[],
  environmentName?: string,
): void => {
  const baseBranch = input.repo?.baseBranch;
  if (baseBranch == null) return;
  const [problem] = findBaseBranchEnvProblems(baseBranch, vars);
  if (problem !== undefined) {
    throw new RepoBaseBranchInvalidError(problem, environmentName);
  }
};

/**
 * Applies the step-kind rules to the step definition's runtime, checks a
 * named environment against its latest version, then turns its environment
 * and independent overrides into a task execution config row, or `null`
 * when nothing overrides the repo's config (D3). Call inside the
 * transaction that persists the step definition.
 */
export const resolveStepDefinitionTaskExecutionConfig = async (
  input: CreateStepDefinitionInput,
  {
    taskExecutionConfigRepo,
    environmentRepo,
  }: ResolveStepDefinitionTaskExecutionConfigDeps,
  dbExecutor: DbExecutor,
): Promise<TaskExecutionConfigEntity | null> => {
  assertStepKindFitsRuntime(
    input.kind,
    input.environment?.kind === "inline"
      ? (input.environment.runtime ?? null)
      : null,
  );
  assertToolCallFitsMcpServers(
    input.kind,
    input.toolCallJson,
    Object.keys(input.opencodeMcpJson ?? {}),
  );
  if (input.environment?.kind === "named") {
    await assertNamedEnvironmentFits(
      input,
      input.environment.name,
      environmentRepo,
      dbExecutor,
    );
  } else {
    assertBaseBranchFitsVars(
      input,
      input.environment?.kind === "inline"
        ? (input.environment.envJson ?? [])
        : [],
    );
  }

  return await resolveTaskExecutionConfig(
    {
      projectId: input.projectId,
      environment: input.environment,
      repo: input.repo,
      opencodeMcpJson: input.opencodeMcpJson,
      healthChecksJson: input.healthChecksJson,
    },
    { taskExecutionConfigRepo },
    dbExecutor,
  );
};
