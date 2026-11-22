import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { TaskExecutionConfigRepo } from "@scarn/core/tasks/task-execution-config/application/task-execution-config-repo";
import type { TaskRunEntity } from "@scarn/core/tasks/task-run/domain/task-run-entity";
import type { ManagedConnectionRepo } from "./managed-connection-repo";

export type ReferencedManagedConnection = {
  key: string;
  /** The connection name the entry's `auth` refers to. */
  name: string;
  connectionId: UuidV7 | null;
};

/**
 * The managed connections a run may use (decision 1): each enabled MCP
 * server in the run's own task execution config whose `auth` names a
 * connection, resolved to the run's project's connection of that name, or `null`
 * when the project has none. The project always comes from the run.
 */
export const loadReferencedManagedConnections = async (
  run: TaskRunEntity,
  {
    taskExecutionConfigRepo,
    managedConnectionRepo,
  }: {
    taskExecutionConfigRepo: Pick<TaskExecutionConfigRepo, "load">;
    managedConnectionRepo: Pick<ManagedConnectionRepo, "loadByName">;
  },
  tx: DbExecutor,
): Promise<ReferencedManagedConnection[]> => {
  const config = run.taskExecutionConfigId
    ? await taskExecutionConfigRepo.load(run.taskExecutionConfigId, tx)
    : null;
  const authed = Object.entries(config?.mcp ?? {}).flatMap(([key, server]) =>
    server.type !== "local" && server.auth && server.disabled !== true
      ? [{ key, name: server.auth.connection }]
      : [],
  );
  return await Promise.all(
    authed.map(async ({ key, name }) => {
      const connection = await managedConnectionRepo.loadByName(
        run.projectId,
        name,
        tx,
      );
      return { key, name, connectionId: connection?.id ?? null };
    }),
  );
};
