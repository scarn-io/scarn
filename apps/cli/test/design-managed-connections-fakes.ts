import type {
  AgentToolsManifest,
  DiscoveredMcpServer,
  ListedMcpTool,
} from "@scarn/worker";
import { ensureAgentToolsManifest } from "../src/lib/design-agent-tools";
import type {
  ManagedConnectionSummary,
  ManagedConnectionsPorts,
} from "../src/lib/design-managed-connections";
import {
  EMPTY_DISCOVERY,
  FAKE_AGENT_TOOLS_MANIFEST_PATH,
  fakeAgentToolsPorts,
} from "./design-agent-tools-fakes";
import { createReporterRecorder } from "./utils";

export const NOTION_URL = "https://mcp.notion.com/mcp";

export function notionServer(name = "notion"): DiscoveredMcpServer {
  return {
    name,
    source: ".mcp.json",
    transport: "remote",
    config: { type: "remote", url: NOTION_URL },
    requiredEnv: [],
    inlineSecrets: [],
    shadowed: [],
  };
}

export function connection(
  overrides: Partial<ManagedConnectionSummary> = {},
): ManagedConnectionSummary {
  return {
    id: "conn-1",
    projectId: "project-1",
    name: "notion",
    label: "Notion",
    preset: "notion",
    resource: NOTION_URL,
    state: "ready",
    reasonCode: null,
    generation: 1,
    version: 1,
    connectedBy: { userId: "user-1", username: "dana" },
    account: {
      userName: "Dana",
      workspaceName: "Acme",
      identityVerified: true,
    },
    grantedScopes: [],
    reconnectBy: null,
    candidate: null,
    lastRevocation: null,
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
    ...overrides,
  };
}

export const SEARCH_TOOL: ListedMcpTool = {
  name: "notion-search",
  description: "Search the workspace",
  inputSchema: { type: "object" },
  readOnlyHint: true,
};

export type ToolsAnswer = Awaited<
  ReturnType<ManagedConnectionsPorts["listManagedConnectionTools"]>
>;

/**
 * Run the manifest step against a fake API. `tools` answers successive calls
 * to the tools route in order; the last answer repeats.
 */
export async function runWithConnections(input: {
  servers?: DiscoveredMcpServer[];
  list?: ManagedConnectionsPorts["listManagedConnections"];
  connections?: ManagedConnectionSummary[];
  tools?: ToolsAnswer[];
  localStarts?: string[];
}): Promise<{
  manifest: AgentToolsManifest | undefined;
  result: string | null;
  toolCalls: number;
  recorder: ReturnType<typeof createReporterRecorder>;
}> {
  const written: AgentToolsManifest[] = [];
  const recorder = createReporterRecorder();
  const answers = input.tools ?? [{ ok: true, tools: [SEARCH_TOOL] }];
  let toolCalls = 0;
  const result = await ensureAgentToolsManifest({
    baseUrl: "https://scarn.test",
    projectId: "project-1",
    project: "acme/app",
    owner: "acme",
    slug: "app",
    reporter: recorder.reporter,
    now: () => new Date("2026-11-18T00:00:00Z"),
    ports: fakeAgentToolsPorts({
      discoverAgentTools: () =>
        Promise.resolve({
          ...EMPTY_DISCOVERY,
          servers: input.servers ?? [notionServer()],
        }),
      mcpToolLister: {
        listTools: ({ server }) => {
          input.localStarts?.push(server.name);
          return Promise.resolve([
            { name: "query", inputSchema: { type: "object" } },
          ]);
        },
      },
      listManagedConnections:
        input.list ??
        (() =>
          Promise.resolve({
            ok: true,
            connections: input.connections ?? [connection()],
          })),
      listManagedConnectionTools: () => {
        const answer = answers[Math.min(toolCalls, answers.length - 1)];
        toolCalls += 1;
        return answer === undefined
          ? Promise.reject(new Error("no answer"))
          : Promise.resolve(answer);
      },
      writeAgentToolsManifest: ({ manifest }) => {
        written.push(manifest);
        return Promise.resolve(FAKE_AGENT_TOOLS_MANIFEST_PATH);
      },
    }),
  });
  return { manifest: written[0], result, toolCalls, recorder };
}
