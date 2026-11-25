import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { ResourceNotFoundError } from "@scarn/core/lib/errors";
import { Result } from "@scarn/core/lib/result";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import type { EnvironmentRepo } from "@scarn/core/pipeline-definitions/environment/application/environment-repo";
import { inlineConfigFieldsFromTaskExecutionConfig } from "@scarn/core/pipeline-definitions/step-definition/application/step-definition-contract-mapper";
import { revealProjectSecrets } from "@scarn/core/secrets/secret/application/reveal-project-secrets";
import type { SecretCipher } from "@scarn/core/secrets/secret/application/secret-cipher";
import type { SecretRepo } from "@scarn/core/secrets/secret/application/secret-repo";
import type { TaskExecutionConfigRepo } from "@scarn/core/tasks/task-execution-config/application/task-execution-config-repo";
import type { TaskRepo } from "@scarn/core/tasks/task/application/task-repo";
import {
  getTaskRunInputSchema,
  type GetTaskRunInput,
} from "../contracts/task-run-contracts";
import {
  resolveTaskRunEnvironmentInputSchema,
  type ResolveTaskRunEnvironmentInput,
  type TaskRunEnvironmentContract,
} from "../contracts/task-run-environment-contracts";
import { SecretNotReferencedError } from "../domain/secret-not-referenced-error";
import type { TaskRunEntity } from "../domain/task-run-entity";
import type { TaskRunRepo } from "./task-run-repo";
import { assertClaimOwnership } from "./task-run-claim-helpers";

type EnvVars =
  | readonly { source: string; secretName?: string | undefined }[]
  | null
  | undefined;

const secretNamesOf = (vars: EnvVars): Set<string> =>
  new Set(
    (vars ?? []).flatMap((entry) =>
      entry.source === "secret" && entry.secretName !== undefined
        ? [entry.secretName]
        : [],
    ),
  );

type ReferencedSecretDeps = {
  taskRepo: Pick<TaskRepo, "load">;
  taskExecutionConfigRepo: Pick<TaskExecutionConfigRepo, "load">;
  environmentRepo: Pick<EnvironmentRepo, "findVersionById">;
};

type McpServers = Readonly<
  Record<string, { auth?: unknown; workerVars?: EnvVars }>
> | null;

/**
 * The `secret` worker vars of the step's MCP servers. A server with `auth`
 * is authenticated by its connection and reads none.
 */
const mcpSecretNamesOf = (servers: McpServers): Set<string> =>
  new Set(
    Object.values(servers ?? {}).flatMap((server) =>
      server.auth === undefined ? [...secretNamesOf(server.workerVars)] : [],
    ),
  );

/**
 * The project secret names the run's step references: the `secret` vars of
 * its inline environment, or of the named environment version pinned on the
 * run when its worker context was built, and the `secret` worker vars of its
 * MCP servers. The repo default, and a named environment not yet pinned,
 * reference none of their own.
 */
const loadEnvironmentSecretNames = async (
  task: TaskRunEntity,
  {
    taskExecutionConfigRepo,
    environmentRepo,
  }: Omit<ReferencedSecretDeps, "taskRepo">,
  tx: DbExecutor,
): Promise<Set<string>> => {
  const config = task.taskExecutionConfigId
    ? await taskExecutionConfigRepo.load(task.taskExecutionConfigId, tx)
    : null;
  const { environment, opencodeMcpJson } =
    inlineConfigFieldsFromTaskExecutionConfig(config);
  const names = await loadOwnEnvironmentSecretNames(
    task,
    environment,
    environmentRepo,
    tx,
  );
  for (const name of mcpSecretNamesOf(opencodeMcpJson)) names.add(name);
  return names;
};

const loadOwnEnvironmentSecretNames = async (
  task: TaskRunEntity,
  environment: ReturnType<
    typeof inlineConfigFieldsFromTaskExecutionConfig
  >["environment"],
  environmentRepo: ReferencedSecretDeps["environmentRepo"],
  tx: DbExecutor,
): Promise<Set<string>> => {
  if (environment === null) return new Set();
  if (environment.kind === "inline") return secretNamesOf(environment.envJson);
  if (task.environmentVersionId === null) return new Set();
  const pinned = await environmentRepo.findVersionById(
    task.environmentVersionId,
    tx,
  );
  return pinned &&
    pinned.environment.name === environment.name &&
    pinned.environment.projectId === task.projectId
    ? secretNamesOf(pinned.version.content.vars)
    : new Set();
};

/**
 * The secret names the run may fetch: its environment's
 * (`loadEnvironmentSecretNames`) and those its Task's extra connectors
 * name (decision 5).
 */
const loadReferencedSecretNames = async (
  run: TaskRunEntity,
  deps: ReferencedSecretDeps,
  tx: DbExecutor,
): Promise<Set<string>> => {
  const [names, task] = await Promise.all([
    loadEnvironmentSecretNames(run, deps, tx),
    deps.taskRepo.load(run.taskId, tx),
  ]);
  for (const extra of task?.environmentSelection?.extraConnectors ?? []) {
    for (const { secret } of Object.values(extra.vars)) names.add(secret);
  }
  return names;
};

/**
 * Gives the worker holding a Task's claim the values of the named project
 * secrets, from the Task's own project only, and lists the names that
 * project doesn't have. Requires the claim and `executions:write`. Only the
 * secrets the run's environment or its Task's extra connectors reference
 * may be asked for; any other name fails the whole request with
 * `SECRET_NOT_REFERENCED` (ADR 0007).
 */
export const resolveTaskRunEnvironmentSecrets = async (
  taskIdInput: GetTaskRunInput,
  input: ResolveTaskRunEnvironmentInput,
  {
    userAuthz,
    taskRepo,
    taskRunRepo,
    taskExecutionConfigRepo,
    environmentRepo,
    secretRepo,
    secretCipher,
    timeProvider,
    dbExecutor,
  }: {
    userAuthz: UserAuthorizationService;
    taskRepo: Pick<TaskRepo, "load">;
    taskRunRepo: TaskRunRepo;
    taskExecutionConfigRepo: Pick<TaskExecutionConfigRepo, "load">;
    environmentRepo: Pick<EnvironmentRepo, "findVersionById">;
    secretRepo: SecretRepo;
    secretCipher: SecretCipher;
    timeProvider: TimeProvider;
    dbExecutor?: DbExecutor | undefined;
  },
): Promise<Result<TaskRunEnvironmentContract, ResourceNotFoundError>> => {
  const taskRunId = getTaskRunInputSchema.parse(taskIdInput);
  const { claimToken, secretNames } =
    resolveTaskRunEnvironmentInputSchema.parse(input);
  const db = dbExecutor ?? getDb();

  return await db.transaction(async (tx) => {
    const task = await taskRunRepo.load(taskRunId, tx);
    if (!task) {
      return Result.err(new ResourceNotFoundError("Task", taskRunId));
    }
    await userAuthz.requireProjectPermission({
      projectId: task.projectId,
      permission: "executions:write",
    });
    assertClaimOwnership(task, claimToken, timeProvider.now());

    const referenced = await loadReferencedSecretNames(
      task,
      { taskRepo, taskExecutionConfigRepo, environmentRepo },
      tx,
    );
    const rejected = secretNames.filter((name) => !referenced.has(name));
    if (rejected.length > 0) {
      throw new SecretNotReferencedError(rejected, [...referenced]);
    }

    const { values, missing } = await revealProjectSecrets(
      task.projectId,
      secretNames,
      { secretRepo, secretCipher, timeProvider, dbExecutor: tx },
    );

    return Result.ok({
      secrets: Object.fromEntries(
        [...values].map(([name, value]) => [name, { value, expiresAt: null }]),
      ),
      missing,
    });
  });
};
