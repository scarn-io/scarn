import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { CoreError, CoreValidationError } from "@scarn/core/lib/errors";
import { normalizeMcpResourceUrl } from "@scarn/sdk/managed-connections";
import type { RegisterManagedLaunchInput } from "../contracts/managed-launch-contracts";
import type { ServingManagedConnectionEntity } from "../domain/managed-connection-entity";
import type { ReferencedManagedConnection } from "./load-referenced-managed-connections";
import type { ManagedConnectionRepo } from "./managed-connection-repo";

/** The code a launch fails with when a step's MCP server can't use its connection auth. */
export const MCP_CONNECTION_AUTH_INVALID_CODE =
  "SCARN_MCP_CONNECTION_AUTH_INVALID";

type LaunchUrls = RegisterManagedLaunchInput["entries"];

const authSnippet = (name: string) => `auth: { connection: "${name}" }`;

const mcpConnectionAuthInvalid = (
  message: string,
  meta: Record<string, string>,
) => new CoreValidationError(message, MCP_CONNECTION_AUTH_INVALID_CODE, meta);

/**
 * Refuses (400) a registration that doesn't carry a resolved URL for every
 * connection-auth entry in the run's config. Entries the config doesn't
 * reference are ignored.
 */
export const requireEntryUrls = (
  referenced: readonly ReferencedManagedConnection[],
  entries: LaunchUrls,
): void => {
  const missing = referenced
    .map(({ key }) => key)
    .filter((key) => entries[key] === undefined);
  if (missing.length > 0) {
    throw new CoreError({
      code: "MANAGED_LAUNCH_ENTRY_URL_MISSING",
      message: `The launch registration has no resolved URL for MCP servers ${missing.map((key) => `"${key}"`).join(", ")}`,
      status: 400,
    });
  }
};

/**
 * Refuses with `SCARN_MCP_CONNECTION_AUTH_INVALID` when the URL the worker
 * resolved for `entry` isn't a valid MCP URL or doesn't normalize to its
 * connection's `resource` (ADR 0013 decision 40). Correctness only: the relay
 * always forwards to the stored `resource`.
 */
export const assertEntryUrlMatches = (
  entry: ReferencedManagedConnection,
  url: string,
  connection: ServingManagedConnectionEntity,
): void => {
  const expected = connection.server.resource;
  if (normalizeMcpResourceUrl(url) === expected) {
    return;
  }
  throw mcpConnectionAuthInvalid(
    `MCP server "${entry.key}" uses the project's "${entry.name}" connection (${authSnippet(entry.name)}), ` +
      `but its URL is not the connection's. Point it at ${expected}.`,
    { key: entry.key, connection: entry.name, expectedUrl: expected },
  );
};

/**
 * Refuses with `SCARN_MCP_CONNECTION_AUTH_INVALID` when an enabled remote
 * without `auth` points at one of the project's connections, which it would
 * reach without the connection's credentials (ADR 0013 decision 40). A URL
 * that isn't a valid MCP URL can't be a connection's and is skipped.
 */
export const assertNoUnauthedConnectionRemote = async (
  projectId: UuidV7,
  remotes: LaunchUrls,
  repo: Pick<ManagedConnectionRepo, "loadByResource">,
  tx: DbExecutor,
): Promise<void> => {
  for (const [key, { url }] of Object.entries(remotes)) {
    const resource = normalizeMcpResourceUrl(url);
    const connection = resource
      ? await repo.loadByResource(projectId, resource, tx)
      : null;
    if (connection) {
      throw mcpConnectionAuthInvalid(
        `MCP server "${key}" points at the project's "${connection.name}" connection (${connection.server.resource}) but has no auth. ` +
          `Add ${authSnippet(connection.name)} to it.`,
        { key, connection: connection.name },
      );
    }
  }
};
