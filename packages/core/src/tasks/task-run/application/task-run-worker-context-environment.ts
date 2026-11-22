import type {
  EnvironmentRef,
  ResolvedEnvironmentRef,
} from "@scarn/core/common/contracts/environment";
import type { EnvironmentRepo } from "@scarn/core/pipeline-definitions/environment/application/environment-repo";
import type { CoreValidationError } from "@scarn/core/lib/errors";
import type { TaskExecutionConfigEntity } from "@scarn/core/tasks/task-execution-config/domain/task-execution-config-entity";
import { environmentFitsStep } from "@scarn/core/tasks/task/domain/environment-fits-step";
import { extraConnectorsFit } from "@scarn/core/tasks/task/domain/extra-connectors-fit";
import type { ExtraConnector } from "@scarn/core/tasks/task/domain/task-environment-selection";
import type { TaskKind, TaskRunEntity } from "../domain/task-run-entity";
import type { TaskRunRepo } from "./task-run-repo";

type EnvironmentDeps = {
  environmentRepo: Pick<
    EnvironmentRepo,
    "findVersionById" | "findLiveWithLatestVersionByName"
  >;
  taskRunRepo: Pick<TaskRunRepo, "pinEnvironmentVersion">;
};

/**
 * The run's environment as the worker gets it. A named environment uses the
 * version pinned on the run while it still belongs to a live environment of
 * that name; otherwise the latest version, which is then pinned so later
 * reads get the same one. A name with no live environment is `notFound`.
 */
export const resolveRunEnvironment = async (
  run: Pick<TaskRunEntity, "id" | "projectId" | "environmentVersionId">,
  environment: EnvironmentRef,
  deps: EnvironmentDeps,
): Promise<ResolvedEnvironmentRef> => {
  if (environment === null || environment.kind === "inline") {
    return environment;
  }
  const { name } = environment;
  const pinned =
    run.environmentVersionId === null
      ? null
      : await deps.environmentRepo.findVersionById(run.environmentVersionId);
  if (
    pinned &&
    pinned.environment.name === name &&
    pinned.environment.projectId === run.projectId
  ) {
    return pinned.environment.deletedAt === null
      ? {
          kind: "named",
          name,
          version: pinned.version.version,
          content: pinned.version.content,
        }
      : { kind: "named", name, notFound: true };
  }
  const latest = await deps.environmentRepo.findLiveWithLatestVersionByName(
    run.projectId,
    name,
  );
  if (!latest) {
    return { kind: "named", name, notFound: true };
  }
  const storedId = await deps.taskRunRepo.pinEnvironmentVersion(
    run.id,
    latest.latestVersion.id,
    run.environmentVersionId,
  );
  if (storedId !== null && storedId !== latest.latestVersion.id) {
    return resolveRunEnvironment(
      { ...run, environmentVersionId: storedId },
      environment,
      deps,
    );
  }
  return {
    kind: "named",
    name,
    version: latest.latestVersion.version,
    content: latest.latestVersion.content,
  };
};

/**
 * Decisions 4 and 5 again at startup, because an environment can change
 * after its Task is created: a named environment's resolved version must
 * still fit the step (`environmentFitsStep`), and the Task's extra
 * connectors must still fit the effective environment and the step's
 * `mcps`. A name with no live environment is left to the worker, which
 * fails the run as not found. Returns the first problem as a 422, or
 * `null` when the run can start.
 */
export const runEnvironmentFitsStep = ({
  environment,
  stepKind,
  stepConfig,
  extraConnectors,
}: {
  environment: ResolvedEnvironmentRef;
  stepKind: TaskKind;
  stepConfig: TaskExecutionConfigEntity | null;
  extraConnectors: readonly ExtraConnector[];
}): CoreValidationError | null => {
  if (environment?.kind === "named" && "notFound" in environment) return null;
  if (environment?.kind === "named") {
    const misfit = environmentFitsStep({
      name: environment.name,
      content: environment.content,
      stepKind,
      stepConfig,
    });
    if (misfit !== null) return misfit;
  }
  if (extraConnectors.length === 0) return null;
  const effective =
    environment === null
      ? {}
      : environment.kind === "inline"
        ? {
            connectors: environment.connectors,
            vars: environment.envJson ?? [],
          }
        : environment.content;
  return extraConnectorsFit(
    extraConnectors,
    effective,
    Object.keys(stepConfig?.mcp ?? {}),
  );
};
