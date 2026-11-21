import type { DiscoveredAgentTools } from "@scarn/worker";
import type { AgentToolsPorts } from "../src/lib/design-agent-tools";

export const FAKE_AGENT_TOOLS_MANIFEST_PATH =
  "/home/test/.scarn/projects/acme/app/discovered-tools.json";

export const EMPTY_DISCOVERY: DiscoveredAgentTools = {
  servers: [],
  skills: [],
  skipped: [],
  searched: [],
};

/**
 * Agent-tools ports for a repository with no MCP servers or skills and a
 * project with no managed connections: nothing is started, and the manifest
 * "write" returns a fixed path.
 */
export function fakeAgentToolsPorts(
  overrides: Partial<AgentToolsPorts> = {},
): AgentToolsPorts {
  return {
    discoverAgentTools: () => Promise.resolve(EMPTY_DISCOVERY),
    readToolEnv: () => Promise.resolve({}),
    mcpToolLister: {
      listTools: () => Promise.reject(new Error("no server to list")),
    },
    readMcpToolLocks: () => Promise.resolve([]),
    writeAgentToolsManifest: () =>
      Promise.resolve(FAKE_AGENT_TOOLS_MANIFEST_PATH),
    listManagedConnections: () =>
      Promise.resolve({ ok: true, connections: [] }),
    listManagedConnectionTools: () =>
      Promise.reject(new Error("no connection to list")),
    ...overrides,
  };
}
