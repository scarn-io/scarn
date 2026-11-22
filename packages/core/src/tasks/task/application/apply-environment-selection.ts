import type { EnvironmentContent } from "@scarn/core/common/contracts/environment";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { CoreValidationError } from "@scarn/core/lib/errors";
import { Result } from "@scarn/core/lib/result";
import type { EnvironmentRepo } from "@scarn/core/pipeline-definitions/environment/application/environment-repo";
import type { TaskExecutionConfigRepo } from "@scarn/core/tasks/task-execution-config/application/task-execution-config-repo";
import { TaskExecutionConfigEntity } from "@scarn/core/tasks/task-execution-config/domain/task-execution-config-entity";
import type { TaskKind } from "@scarn/core/tasks/task-run/domain/task-run-entity";
import { environmentFitsStep } from "../domain/environment-fits-step";
import { extraConnectorsFit } from "../domain/extra-connectors-fit";
import {
  taskEnvironmentSelection,
  type ExtraConnector,
  type TaskEnvironmentSelection,
} from "../domain/task-environment-selection";

export type ApplyEnvironmentSelectionDeps = {
  environmentRepo: Pick<EnvironmentRepo, "findLiveWithLatestVersionByName">;
  taskExecutionConfigRepo: Pick<TaskExecutionConfigRepo, "findOrCreate">;
};

export type ApplyEnvironmentSelectionInput = {
  projectId: UuidV7;
  /**
   * The step's config, or a prompt Task's (`promptTaskExecutionConfig`);
   * `null` when it is the repo default.
   */
  baseConfig: TaskExecutionConfigEntity | null;
  stepKind: TaskKind;
  override: { name: string } | null;
  extraConnectors: readonly ExtraConnector[];
};

export type AppliedEnvironmentSelection = {
  taskExecutionConfigId: UuidV7 | null;
  selection: TaskEnvironmentSelection | null;
};

const environmentNotFound = (name: string) =>
  new CoreValidationError(
    `Environment "${name}" not found`,
    "ENVIRONMENT_NOT_FOUND",
    { name },
  );

const loadEnvironmentContent = async (
  projectId: UuidV7,
  name: string,
  deps: ApplyEnvironmentSelectionDeps,
  tx: DbExecutor,
): Promise<EnvironmentContent | null> => {
  const found = await deps.environmentRepo.findLiveWithLatestVersionByName(
    projectId,
    name,
    tx,
  );
  return found?.latestVersion.content ?? null;
};

/**
 * Applies what a person chose about a new standalone Task's environment
 * (decisions 2–5). With no override the Task keeps `baseConfig`. An
 * override names a live named environment that must fit the step
 * (`environmentFitsStep`); the Task then gets a config derived from
 * `baseConfig` (or the repo default) that runs in it, shared with every
 * Task with the same content. An inline step environment can't be
 * overridden. Extra connectors are checked against the effective
 * environment's latest version and the step's `mcps`. Call inside the
 * transaction that creates the Task.
 */
export const applyEnvironmentSelection = async (
  input: ApplyEnvironmentSelectionInput,
  deps: ApplyEnvironmentSelectionDeps,
  tx: DbExecutor,
): Promise<Result<AppliedEnvironmentSelection, CoreValidationError>> => {
  const { projectId, baseConfig, stepKind, override, extraConnectors } = input;
  const baseEnvironment = baseConfig?.environment ?? null;
  const stepMcpKeys = Object.keys(baseConfig?.mcp ?? {});

  if (override === null) {
    if (extraConnectors.length > 0) {
      let environment: Pick<EnvironmentContent, "connectors" | "vars"> = {};
      if (baseEnvironment?.kind === "inline") {
        environment = baseEnvironment;
      } else if (baseEnvironment?.kind === "named") {
        const content = await loadEnvironmentContent(
          projectId,
          baseEnvironment.name,
          deps,
          tx,
        );
        if (content === null) {
          return Result.err(environmentNotFound(baseEnvironment.name));
        }
        environment = content;
      }
      const problem = extraConnectorsFit(
        extraConnectors,
        environment,
        stepMcpKeys,
      );
      if (problem !== null) return Result.err(problem);
    }
    return Result.ok({
      taskExecutionConfigId: baseConfig?.id ?? null,
      selection: taskEnvironmentSelection(extraConnectors),
    });
  }

  if (baseEnvironment?.kind === "inline") {
    return Result.err(
      new CoreValidationError(
        "This step defines its own inline environment, which can't be replaced",
        "ENVIRONMENT_OVERRIDE_INLINE",
        { name: override.name },
      ),
    );
  }
  const content = await loadEnvironmentContent(
    projectId,
    override.name,
    deps,
    tx,
  );
  if (content === null) return Result.err(environmentNotFound(override.name));
  const misfit = environmentFitsStep({
    name: override.name,
    content,
    stepKind,
    stepConfig: baseConfig,
  });
  if (misfit !== null) return Result.err(misfit);
  const problem = extraConnectorsFit(extraConnectors, content, stepMcpKeys);
  if (problem !== null) return Result.err(problem);

  const derived = await deps.taskExecutionConfigRepo.findOrCreate(
    (
      baseConfig ??
      TaskExecutionConfigEntity.create({
        projectId,
        content: {
          environment: null,
          git: null,
          mcp: null,
          healthChecks: null,
        },
      })
    ).withNamedEnvironment(override.name),
    tx,
  );
  return Result.ok({
    taskExecutionConfigId: derived.id,
    selection: taskEnvironmentSelection(extraConnectors),
  });
};
