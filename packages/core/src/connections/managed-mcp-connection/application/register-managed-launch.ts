import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { CoreError, ResourceNotFoundError } from "@scarn/core/lib/errors";
import { Result } from "@scarn/core/lib/result";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import type { TaskExecutionConfigRepo } from "@scarn/core/tasks/task-execution-config/application/task-execution-config-repo";
import {
  getTaskRunInputSchema,
  type GetTaskRunInput,
} from "@scarn/core/tasks/task-run/contracts/task-run-contracts";
import { assertClaimOwnership } from "@scarn/core/tasks/task-run/application/task-run-claim-helpers";
import type { TaskRunRepo } from "@scarn/core/tasks/task-run/application/task-run-repo";
import type { TaskRunEntity } from "@scarn/core/tasks/task-run/domain/task-run-entity";
import {
  managedRelayUrlFor,
  registerManagedLaunchInputSchema,
  type ManagedLaunchContract,
  type RegisterManagedLaunchInput,
} from "../contracts/managed-launch-contracts";
import {
  isServingManagedConnection,
  type ManagedConnectionEntity,
  type ServingManagedConnectionEntity,
} from "../domain/managed-connection-entity";
import { createManagedConnectionEvent } from "../domain/managed-connection-event";
import { ManagedLaunchConnectionEntity } from "../domain/managed-launch-connection-entity";
import {
  launchClaimTokenDigest,
  randomRelayCapability,
  relayCapabilityDigest,
} from "../domain/managed-launch-digests";
import {
  assertEntryUrlMatches,
  assertNoUnauthedConnectionRemote,
  requireEntryUrls,
} from "./check-managed-launch-urls";
import {
  loadReferencedManagedConnections,
  type ReferencedManagedConnection,
} from "./load-referenced-managed-connections";
import { ManagedConnectionNotReadyError } from "./managed-connection-access";
import type { ManagedConnectionEventRepo } from "./managed-connection-event-repo";
import type { ManagedConnectionRepo } from "./managed-connection-repo";
import type { ManagedLaunchRepo } from "./managed-launch-repo";

export type RegisterManagedLaunchDeps = {
  userAuthz: UserAuthorizationService;
  taskRunRepo: Pick<TaskRunRepo, "lock">;
  taskExecutionConfigRepo: Pick<TaskExecutionConfigRepo, "load">;
  managedConnectionRepo: Pick<
    ManagedConnectionRepo,
    "loadByName" | "loadByResource" | "loadForShare"
  >;
  managedLaunchRepo: Pick<ManagedLaunchRepo, "upsertOpen">;
  managedConnectionEventRepo: Pick<ManagedConnectionEventRepo, "append">;
  timeProvider: TimeProvider;
  /** The API's public base URL, including the `/api` mount. */
  apiBaseUrl: string | null;
  dbExecutor?: DbExecutor | undefined;
};

const missingApiBaseUrl = () =>
  new CoreError({
    code: "MISSING_CONFIG",
    message: "APP_URL environment variable is not set",
    status: 500,
  });

const reasonCodeOf = (connection: ManagedConnectionEntity | null) =>
  connection && "reasonCode" in connection ? connection.reasonCode : null;

/** The entry's connection, locked `FOR SHARE`, or `MANAGED_CONNECTION_NOT_READY` (decision 13). */
const requireServing = async (
  run: TaskRunEntity,
  entry: ReferencedManagedConnection,
  deps: RegisterManagedLaunchDeps,
  tx: DbExecutor,
): Promise<ServingManagedConnectionEntity> => {
  const connection = entry.connectionId
    ? await deps.managedConnectionRepo.loadForShare(
        run.projectId,
        entry.connectionId,
        tx,
      )
    : null;
  if (connection && isServingManagedConnection(connection)) {
    return connection;
  }
  throw new ManagedConnectionNotReadyError(
    connection?.state ?? "disconnected",
    reasonCodeOf(connection),
    {
      message: connection
        ? `The ${connection.label} connection ("${entry.name}") that MCP server "${entry.key}" uses is not ready: a project admin must reconnect it`
        : `MCP server "${entry.key}" uses the "${entry.name}" connection, which this project doesn't have: a project admin must connect it`,
      meta: {
        key: entry.key,
        connection: entry.name,
        label: connection?.label ?? null,
      },
    },
  );
};

/**
 * Registers the launch of a run the worker holds the claim on
 * (`POST /task-runs/:taskRunId/managed-launch`). For each connection-auth
 * MCP server in the run's own config, it requires the worker's resolved URL
 * for it (400 when missing), the project's connection to be serving
 * (`MANAGED_CONNECTION_NOT_READY`), and that URL to normalize to the
 * connection's `resource` (`SCARN_MCP_CONNECTION_AUTH_INVALID`). When the run
 * has such servers, an enabled remote without `auth` at a connection's URL is
 * refused the same way (ADR 0013 decision 40). It then pins each
 * connection's generation and grant on a launch connection, and mints a
 * fresh relay capability whose digest alone is stored. Registering again
 * under the same claim rotates every capability: the old ones stop
 * matching. Capabilities appear only in this response.
 */
export const registerManagedLaunch = async (
  taskRunIdInput: GetTaskRunInput,
  input: RegisterManagedLaunchInput,
  deps: RegisterManagedLaunchDeps,
): Promise<Result<ManagedLaunchContract, ResourceNotFoundError>> => {
  const taskRunId = getTaskRunInputSchema.parse(taskRunIdInput);
  const {
    claimToken,
    entries: entryUrls,
    remotesWithoutAuth,
  } = registerManagedLaunchInputSchema.parse(input);
  const { apiBaseUrl } = deps;
  if (!apiBaseUrl) {
    throw missingApiBaseUrl();
  }
  const db = deps.dbExecutor ?? getDb();

  return await db.transaction(async (tx) => {
    const run = await deps.taskRunRepo.lock(taskRunId, tx);
    if (!run) {
      return Result.err(new ResourceNotFoundError("Task", taskRunId));
    }
    await deps.userAuthz.requireProjectPermission({
      projectId: run.projectId,
      permission: "executions:write",
    });
    const now = deps.timeProvider.now();
    assertClaimOwnership(run, claimToken, now);

    const referenced = await loadReferencedManagedConnections(run, deps, tx);
    requireEntryUrls(referenced, entryUrls);
    const serving: {
      entry: ReferencedManagedConnection;
      connection: ServingManagedConnectionEntity;
    }[] = [];
    for (const entry of referenced) {
      const connection = await requireServing(run, entry, deps, tx);
      assertEntryUrlMatches(entry, entryUrls[entry.key]?.url ?? "", connection);
      serving.push({ entry, connection });
    }
    if (referenced.length > 0) {
      await assertNoUnauthedConnectionRemote(
        run.projectId,
        remotesWithoutAuth,
        deps.managedConnectionRepo,
        tx,
      );
    }

    const claimTokenDigest = launchClaimTokenDigest(claimToken);
    const entries: ManagedLaunchContract["entries"] = {};
    for (const { entry, connection } of serving) {
      const capability = randomRelayCapability();
      const launch = await deps.managedLaunchRepo.upsertOpen(
        ManagedLaunchConnectionEntity.create({
          projectId: run.projectId,
          taskRunId: run.id,
          claimTokenDigest,
          entryKey: entry.key,
          connection,
          capabilityDigest: relayCapabilityDigest(capability),
          now,
        }),
        tx,
      );
      await deps.managedConnectionEventRepo.append(
        createManagedConnectionEvent({
          projectId: run.projectId,
          connectionId: connection.id,
          actorUserId: deps.userAuthz.actorId,
          taskRunId: run.id,
          type: "launch_registered",
          generation: connection.generation,
          createdAt: now,
        }),
        tx,
      );
      entries[entry.key] = {
        relayUrl: managedRelayUrlFor(apiBaseUrl, launch.id),
        capability,
      };
    }
    return Result.ok({ entries });
  });
};
