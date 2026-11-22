import { z } from "zod";

/** Where the relay is mounted under the API's public base URL (`/api`). */
export const MANAGED_RELAY_PATH = "/mcp-relay";

/** The relay URL of one launch connection. `apiBaseUrl` includes the `/api` mount. */
export const managedRelayUrlFor = (
  apiBaseUrl: string,
  launchConnectionId: string,
): string =>
  `${apiBaseUrl.trim().replace(/\/+$/u, "")}${MANAGED_RELAY_PATH}/${launchConnectionId}`;

const launchUrlsSchema = z.record(z.string(), z.object({ url: z.string() }));

/**
 * A worker registers its launch of a run it holds the claim on, with the URL
 * it resolved for each MCP server: `entries` has every enabled entry with
 * `auth: { connection }` (a `ref`'s URL comes from the repository, which
 * only the worker reads), and `remotesWithoutAuth` every other enabled
 * remote, so a server pointed at a connection's URL without `auth` is caught.
 */
export const registerManagedLaunchInputSchema = z.object({
  claimToken: z.string().trim().min(1),
  entries: launchUrlsSchema,
  remotesWithoutAuth: launchUrlsSchema,
});

export const managedLaunchEntrySchema = z.object({
  relayUrl: z.string(),
  /** The bearer the agent's MCP client sends to `relayUrl`. Shown only in this response. */
  capability: z.string(),
});

/** One entry per connection-auth MCP server in the run's config, by entry key. */
export const managedLaunchSchema = z.object({
  entries: z.record(z.string(), managedLaunchEntrySchema),
});

export type RegisterManagedLaunchInput = z.input<
  typeof registerManagedLaunchInputSchema
>;
export type ManagedLaunchContract = z.infer<typeof managedLaunchSchema>;
