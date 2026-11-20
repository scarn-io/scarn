import { readFileSync } from "node:fs";
import { managedConnectionNameSchema } from "@scarn/sdk/managed-connections";
import {
  discoverRepoAgentTools,
  type DiscoveredAgentTools,
} from "@scarn/worker";
import { z } from "zod";

/**
 * The pushed steps' `ref` and `remote` MCP servers, as the push script
 * recorded them, with the URL each will reach at launch where it can be
 * known before a run. A remote's is its `url`. A ref's comes from the
 * repository's MCP files in the working tree, found the way the worker finds
 * them (`discoverRepoAgentTools`); the worker reads the branch it clones, so
 * this is a preview, not the launch check.
 */

const pushedMcpServerSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("remote"),
    step: z.string(),
    key: z.string(),
    connection: managedConnectionNameSchema.nullable(),
    url: z.string(),
  }),
  z.object({
    type: z.literal("ref"),
    step: z.string(),
    key: z.string(),
    connection: managedConnectionNameSchema.nullable(),
    name: z.string(),
    disabled: z.boolean().optional(),
  }),
]);

export type PushedMcpServer = z.infer<typeof pushedMcpServerSchema>;

const pushResultSchema = z.object({
  mcpServers: z.array(pushedMcpServerSchema),
});

/** The MCP servers the push script recorded, or [] when it recorded nothing readable. */
export function readPushedMcpServers(path: string): PushedMcpServer[] {
  try {
    const parsed = pushResultSchema.safeParse(
      JSON.parse(readFileSync(path, "utf8")),
    );
    return parsed.success ? parsed.data.mcpServers : [];
  } catch {
    return [];
  }
}

/**
 * An enabled step MCP server with the URL it will reach, or `url: null` when
 * that can't be known before a run: a ref that the repository doesn't define,
 * defines as a local server, or couldn't be read.
 */
export type PushedMcpServerUrl = {
  step: string;
  key: string;
  connection: PushedMcpServer["connection"];
  url: string | null;
};

/**
 * Each pushed server with its URL. A ref whose repository definition is
 * disabled (and not re-enabled by the ref) is dropped, as the worker drops
 * it. `tools` is null when the repository couldn't be read.
 */
export function resolvePushedMcpServerUrls(
  servers: readonly PushedMcpServer[],
  tools: DiscoveredAgentTools | null,
): PushedMcpServerUrl[] {
  const discovered = new Map(
    (tools?.servers ?? []).map((server) => [server.name, server.config]),
  );
  return servers.flatMap((server): PushedMcpServerUrl[] => {
    const { step, key, connection } = server;
    if (server.type === "remote") {
      return [{ step, key, connection, url: server.url }];
    }
    const config = discovered.get(server.name);
    if ((server.disabled ?? config?.disabled) === true) return [];
    const url = config?.type === "remote" ? config.url : null;
    return [{ step, key, connection, url }];
  });
}

/**
 * {@link resolvePushedMcpServerUrls} against the MCP files in `repoRoot`,
 * read only when a ref was pushed. An unreadable repository leaves every
 * ref without a URL.
 */
export async function resolvePushedMcpServerUrlsInRepo(
  servers: readonly PushedMcpServer[],
  repoRoot: string,
): Promise<PushedMcpServerUrl[]> {
  const tools = servers.some((server) => server.type === "ref")
    ? await discoverRepoAgentTools(repoRoot).catch(() => null)
    : null;
  return resolvePushedMcpServerUrls(servers, tools);
}
