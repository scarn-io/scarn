import { z } from "zod";

/**
 * Per-connection discovery overrides (decision 10): what a server that
 * deviates from the MCP authorization spec needs to pass the decision 41
 * checks, found by the probe and stored with the connection. Every field is
 * set only when the server needed it.
 *
 * - `resourceMetadataUrl`: the protected-resource metadata URL, on the
 *   resource's origin, when the path-inserted one 404s.
 * - `advertisedResource`: the resource the metadata names when it differs
 *   from the MCP URL only by path. It is the token audience; the relay still
 *   forwards to the MCP URL.
 * - `endpointOrigins`: origins besides the issuer's the authorization and
 *   token endpoints may be on.
 * - `tokenErrors`: `slack` reads token errors from HTTP 200 `{ ok: false }`.
 */

export const managedDiscoveryOverrideValues = [
  "resourceMetadataUrl",
  "advertisedResource",
  "endpointOrigins",
  "tokenErrors",
] as const;

export type ManagedDiscoveryOverride =
  (typeof managedDiscoveryOverrideValues)[number];

export const managedConnectionDiscoverySchema = z
  .object({
    resourceMetadataUrl: z.url().optional(),
    advertisedResource: z.url().optional(),
    endpointOrigins: z.array(z.url()).min(1).optional(),
    tokenErrors: z.literal("slack").optional(),
  })
  .strict();

export type ManagedConnectionDiscovery = z.infer<
  typeof managedConnectionDiscoverySchema
>;

/** The overrides `discovery` sets, in a fixed order. */
export const managedDiscoveryOverridesOf = (
  discovery: ManagedConnectionDiscovery | undefined,
): ManagedDiscoveryOverride[] =>
  managedDiscoveryOverrideValues.filter(
    (override) => discovery?.[override] !== undefined,
  );

/** The resource tokens are issued for: the advertised one, else the MCP URL. */
export const managedConnectionAudience = (server: {
  resource: string;
  discovery?: ManagedConnectionDiscovery | undefined;
}): string => server.discovery?.advertisedResource ?? server.resource;

/** A stable string for `discovery`, for cache keys and comparisons. */
export const managedConnectionDiscoveryKey = (
  discovery: ManagedConnectionDiscovery | undefined,
): string =>
  JSON.stringify([
    discovery?.resourceMetadataUrl ?? null,
    discovery?.advertisedResource ?? null,
    [...(discovery?.endpointOrigins ?? [])].sort(),
    discovery?.tokenErrors ?? null,
  ]);
