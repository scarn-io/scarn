import { z } from "zod";
import { createTolerantReader } from "@scarn/core/lib/db/stored-json";
import type { ManagedConnectionDiscovery } from "../domain/managed-connection-discovery";

/**
 * Read-side schema for `managed_mcp_connections.discovery`. The column is a
 * cache of the discovery overrides the probe found for the server, so it is
 * tolerant rather than versioned: a row that can't be read is returned with
 * no overrides and the connection is re-discovered on its next start.
 *
 * Structural only: strings instead of URLs, no minimum lengths, and the
 * token-error dialect as any string. A dialect this code doesn't know is
 * dropped rather than failing the read. Keys this shape doesn't name are
 * stripped. The write-side rules live in `managedConnectionDiscoverySchema`.
 */

const knownTokenErrors = ["slack"] as const;

const isKnownTokenErrors = (
  value: string,
): value is NonNullable<ManagedConnectionDiscovery["tokenErrors"]> =>
  (knownTokenErrors as readonly string[]).includes(value);

export const storedManagedConnectionDiscoverySchema = z
  .object({
    resourceMetadataUrl: z.string().optional(),
    advertisedResource: z.string().optional(),
    endpointOrigins: z.array(z.string()).optional(),
    tokenErrors: z.string().optional(),
  })
  .transform(({ tokenErrors, ...rest }): ManagedConnectionDiscovery => ({
    ...rest,
    ...(tokenErrors !== undefined && isKnownTokenErrors(tokenErrors)
      ? { tokenErrors }
      : {}),
  }));

/** Reads a connection's `discovery` column, or explains why it is unreadable. */
export const readStoredManagedConnectionDiscovery = createTolerantReader(
  storedManagedConnectionDiscoverySchema,
);
