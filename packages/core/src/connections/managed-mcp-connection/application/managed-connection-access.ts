import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { CoreError, ResourceNotFoundError } from "@scarn/core/lib/errors";
import type { ProjectMembership } from "@scarn/core/projects/project/domain/project-membership";
import type {
  ManagedConnectionReasonCode,
  ManagedConnectionState,
} from "../domain/managed-connection-entity";

/**
 * Who may touch a project's managed connections. Reading needs a current
 * member (no public-project fallback); connecting, confirming and cancelling
 * need a member holding `secrets:write`. A non-member gets the same 404 as a
 * missing project either way.
 */
export const requireConnectionReader = (
  userAuthz: UserAuthorizationService,
  projectId: UuidV7,
  dbExecutor?: DbExecutor,
): Promise<ProjectMembership> =>
  userAuthz.requireProjectMember(projectId, dbExecutor);

export const requireConnectionWriter = async (
  userAuthz: UserAuthorizationService,
  projectId: UuidV7,
  dbExecutor?: DbExecutor,
): Promise<ProjectMembership> => {
  const membership = await userAuthz.requireProjectMember(
    projectId,
    dbExecutor,
  );
  if (!membership.permissions.includes("secrets:write")) {
    throw new CoreError({
      code: "PROJECT_FORBIDDEN",
      message: "You do not have the secrets:write permission on this project",
      status: 403,
      meta: { permission: "secrets:write" },
    });
  }
  return membership;
};

/** Listing a connection's tools needs a member holding `executions:write` (decision 2). */
export const requireConnectionToolLister = async (
  userAuthz: UserAuthorizationService,
  projectId: UuidV7,
  dbExecutor?: DbExecutor,
): Promise<ProjectMembership> => {
  const membership = await userAuthz.requireProjectMember(
    projectId,
    dbExecutor,
  );
  if (!membership.permissions.includes("executions:write")) {
    throw new CoreError({
      code: "PROJECT_FORBIDDEN",
      message:
        "You do not have the executions:write permission on this project",
      status: 403,
      meta: { permission: "executions:write" },
    });
  }
  return membership;
};

/** Whether the actor still holds `secrets:write`, for paths that redirect instead of throwing. */
export const holdsConnectionWrite = async (
  userAuthz: UserAuthorizationService,
  projectId: UuidV7,
  dbExecutor?: DbExecutor,
): Promise<boolean> => {
  try {
    await requireConnectionWriter(userAuthz, projectId, dbExecutor);
    return true;
  } catch (error) {
    if (
      error instanceof CoreError &&
      (error.status === 403 || error.status === 404)
    ) {
      return false;
    }
    throw error;
  }
};

export const managedConnectionNotFound = (connectionId: UuidV7) =>
  new ResourceNotFoundError("Managed connection", connectionId);

/**
 * Carries the connection's `state` and `reasonCode` in its public `meta`,
 * plus whatever `detail` adds (a launch names the entry and provider).
 */
export class ManagedConnectionNotReadyError extends CoreError {
  constructor(
    state: ManagedConnectionState,
    reasonCode: ManagedConnectionReasonCode | null,
    detail: { message?: string; meta?: Record<string, unknown> } = {},
  ) {
    super({
      code: "MANAGED_CONNECTION_NOT_READY",
      message: detail.message ?? "The managed connection is not ready to use",
      status: 409,
      meta: { ...detail.meta, state, reasonCode },
    });
  }
}

/**
 * A browser connect or reconnect of a connection whose supplied client only
 * redirects to the user's machine (decision 13). Its public `meta.command` is
 * the CLI command to run instead.
 */
export class ManagedConnectionRequiresCliError extends CoreError {
  constructor(name: string, kind: "connect" | "reconnect") {
    const command = `scarn connections ${kind} ${name}`;
    super({
      code: "MANAGED_CONNECTION_REQUIRES_CLI",
      message: `This connection signs in with a client from your MCP config, which only redirects to your machine. Run \`${command}\` instead.`,
      status: 409,
      meta: { command },
    });
  }
}

export const managedConnectionGrantMissing = () =>
  new CoreError({
    code: "MANAGED_CONNECTION_GRANT_MISSING",
    message: "The managed connection's grant is missing",
    status: 500,
    expose: false,
  });

/** The serving grant is for another MCP resource than the connection's. */
export const managedConnectionGrantMismatch = () =>
  new CoreError({
    code: "MANAGED_CONNECTION_GRANT_MISMATCH",
    message: "The managed connection's grant is for another resource",
    status: 500,
    expose: false,
  });

/** The project already has a connection named `name`, created from something else. */
export const managedConnectionNameTaken = (name: string) =>
  new CoreError({
    code: "MANAGED_CONNECTION_EXISTS",
    message: `This project already has another connection named "${name}". Choose another name.`,
    status: 409,
  });

/** Another of the project's connections, `name`, already uses the MCP URL. */
export const managedConnectionResourceTaken = (name: string) =>
  new CoreError({
    code: "MANAGED_CONNECTION_EXISTS",
    message: `This project's connection "${name}" already uses this MCP URL.`,
    status: 409,
  });

export const managedConnectionVersionConflict = () =>
  new CoreError({
    code: "MANAGED_CONNECTION_VERSION_CONFLICT",
    message:
      "The connection changed since it was loaded. Reload it and try again.",
    status: 409,
  });

/** The provider couldn't be reached, or answered with a server error. */
export const managedConnectionProviderUnavailable = () =>
  new CoreError({
    code: "MANAGED_CONNECTION_PROVIDER_UNAVAILABLE",
    message: "The provider could not be reached. Try again shortly.",
    status: 502,
  });
