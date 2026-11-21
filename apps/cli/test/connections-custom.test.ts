import { describe, expect, test } from "bun:test";
import type { DiscoveredMcpServer } from "@scarn/worker";
import type { createScarnClient } from "@scarn/sdk/client";
import {
  CLIENT_REQUIRED_MESSAGE,
  createConnectionsApi,
  type ConnectionsApi,
} from "../src/lib/connections-api";
import {
  resolveConnectTarget,
  type ConnectTargetInput,
} from "../src/lib/connections-custom";
import {
  runLoopbackSignIn,
  sharedAuthorityDisclosure,
  type LoopbackSignInTarget,
} from "../src/lib/connections-loopback";
import {
  bindLoopbackCallback,
  type BindLoopbackCallbackInput,
} from "../src/lib/loopback-callback";
import {
  baseInput,
  candidateConnection,
  fakeApi,
  ports,
  PROJECT_ID,
  rejectionOf,
} from "./connections-loopback-support";
import { createReporterRecorder, reportedMessages } from "./utils";

/**
 * `connect <name>` for a server from the project's MCP config: resolution,
 * the probe shown before continuing, and the custom start and sign-in.
 */

const SLACK_URL = "https://mcp.slack.test/mcp";

function remoteServer(
  name: string,
  url: string,
  oauth?: { client_id?: string; callback_port?: number; redirect_uri?: string },
): DiscoveredMcpServer {
  return {
    name,
    source: ".mcp.json",
    transport: "remote",
    config: {
      type: "remote",
      url,
      ...(oauth === undefined ? {} : { oauth }),
    },
    requiredEnv: [],
    inlineSecrets: [],
    shadowed: [],
  };
}

const LOCAL_SERVER: DiscoveredMcpServer = {
  name: "db",
  source: ".mcp.json",
  transport: "local",
  config: { type: "local", command: ["db-mcp"] },
  requiredEnv: [],
  inlineSecrets: [],
  shadowed: [],
};

function withPresets(api: ConnectionsApi): ConnectionsApi {
  return {
    ...api,
    listPresets: () =>
      Promise.resolve([
        {
          key: "notion",
          label: "Notion",
          resource: "https://mcp.notion.test/mcp",
          removalUrl: null,
        },
      ]),
  };
}

function targetInput(
  api: ConnectionsApi,
  overrides: Partial<ConnectTargetInput> = {},
) {
  const recorder = createReporterRecorder();
  const prompts: string[] = [];
  const input: ConnectTargetInput = {
    api: withPresets(api),
    projectId: PROJECT_ID,
    name: "slack",
    preset: undefined,
    scopes: [],
    servers: [],
    skipped: [],
    yes: false,
    reporter: recorder.reporter,
    isTty: true,
    prompt: (message) => {
      prompts.push(message);
      return Promise.resolve(true);
    },
    ...overrides,
  };
  return { input, prompts, recorder };
}

async function freePort(): Promise<number> {
  const free = await bindLoopbackCallback({
    host: "127.0.0.1",
    port: 0,
    path: "/callback",
  });
  free.close();
  return free.port;
}

describe("resolveConnectTarget from the MCP config", () => {
  test("a supplied client: probe, show, continue, start custom on its fixed redirect, sign in", async () => {
    const port = await freePort();
    const redirectUri = `http://localhost:${String(port)}/callback`;
    const { api, calls } = fakeApi(
      candidateConnection({ name: "slack", label: "slack", preset: null }),
    );
    const { input, prompts, recorder } = targetInput(api, {
      servers: [
        remoteServer("slack", SLACK_URL, {
          client_id: "claude-client",
          callback_port: port,
        }),
      ],
    });

    const target = await resolveConnectTarget(input);

    const client = { clientId: "claude-client", redirectUri };
    expect(calls["probe"]).toEqual([
      { projectId: PROJECT_ID, resource: SLACK_URL, client },
    ]);
    const shown = reportedMessages(recorder.calls).join("\n");
    expect(shown).toContain("Authorization server: https://auth.provider.test");
    expect(shown).toContain("Endpoint origins: https://auth.provider.test");
    expect(shown).toContain(
      "Signs in as client `claude-client` from your MCP config. The provider sees requests as coming from that app.",
    );
    expect(shown).toContain(sharedAuthorityDisclosure("slack"));
    expect(prompts).toEqual(["Continue?"]);
    expect(target).toEqual({
      kind: "custom",
      custom: {
        name: "slack",
        resource: SLACK_URL,
        confirmIssuerOrigin: "https://auth.provider.test",
        client,
      },
      suppliedRedirectUri: redirectUri,
    });

    const binds: BindLoopbackCallbackInput[] = [];
    const outcome = await runLoopbackSignIn({
      ...baseInput,
      target: target as LoopbackSignInTarget,
      yes: true,
      reporter: recorder.reporter,
      ports: ports(api, {
        bindListener: (bind) => {
          binds.push(bind);
          return bindLoopbackCallback(bind);
        },
      }),
    });

    expect(outcome.kind).toBe("confirmed");
    expect(binds).toEqual([
      { host: "localhost", port, path: "/callback", portFixedBy: "client" },
    ]);
    expect(calls["startCustomLoopback"]).toEqual([
      {
        projectId: PROJECT_ID,
        custom: (target as { custom: object }).custom,
        redirectUri,
      },
    ]);
    expect(calls["complete"]).toHaveLength(1);
  });

  test("without a client ID Scarn registers its own, and redirect_uri is used as given", async () => {
    const { api } = fakeApi();
    const { input, recorder } = targetInput(api, {
      servers: [remoteServer("slack", SLACK_URL)],
    });

    const target = await resolveConnectTarget(input);

    expect(reportedMessages(recorder.calls).join("\n")).toContain(
      "Scarn registers its own client, using a client ID metadata document (CIMD).",
    );
    expect(target).toMatchObject({
      kind: "custom",
      suppliedRedirectUri: null,
    });

    const supplied = await resolveConnectTarget(
      targetInput(api, {
        servers: [
          remoteServer("slack", SLACK_URL, {
            client_id: "c",
            redirect_uri: "http://127.0.0.1:4000/oauth",
          }),
        ],
        yes: true,
      }).input,
    );
    expect(supplied?.suppliedRedirectUri).toBe("http://127.0.0.1:4000/oauth");
  });

  test("the discovery overrides a server needs are shown before continuing", async () => {
    const { api } = fakeApi();
    const { input, prompts, recorder } = targetInput(
      {
        ...api,
        probe: async (probeInput) => ({
          ...(await api.probe(probeInput)),
          endpointOrigins: ["https://slack.test"],
          overrides: {
            resourceMetadataUrl:
              "https://mcp.slack.test/.well-known/oauth-protected-resource",
            advertisedResource: "https://mcp.slack.test",
            endpointOrigins: ["https://slack.test"],
            tokenErrors: "slack",
          },
        }),
      },
      { servers: [remoteServer("slack", SLACK_URL)] },
    );

    await resolveConnectTarget(input);

    const shown = reportedMessages(recorder.calls).join("\n");
    for (const line of [
      "Protected resource metadata from: https://mcp.slack.test/.well-known/oauth-protected-resource",
      "Tokens are issued for: https://mcp.slack.test",
      "Sign-in and token endpoints also on: https://slack.test",
      "Token errors are read the way Slack reports them",
      "This server doesn't follow the MCP authorization spec",
    ]) {
      expect(shown).toContain(line);
    }
    expect(prompts).toEqual(["Continue?"]);
  });

  test("a server that needs no overrides shows none", async () => {
    const { api } = fakeApi();
    const { input, recorder } = targetInput(api, {
      servers: [remoteServer("slack", SLACK_URL)],
    });

    await resolveConnectTarget(input);

    const shown = reportedMessages(recorder.calls).join("\n");
    expect(shown).not.toContain("Tokens are issued for");
    expect(shown).not.toContain("MCP authorization spec");
  });

  test("--yes skips the continue prompt", async () => {
    const { api } = fakeApi();
    const { input, prompts } = targetInput(api, {
      servers: [remoteServer("slack", SLACK_URL)],
      yes: true,
      isTty: false,
    });

    const target = await resolveConnectTarget(input);

    expect(target?.kind).toBe("custom");
    expect(prompts).toEqual([]);
  });

  test("declining the continue prompt starts nothing", async () => {
    const { api, calls } = fakeApi();
    const { input } = targetInput(api, {
      servers: [remoteServer("slack", SLACK_URL)],
      prompt: () => Promise.resolve(false),
    });

    expect(await resolveConnectTarget(input)).toBeNull();
    expect(calls["startCustomLoopback"]).toBeUndefined();
  });

  test("a local server, or a non-loopback redirect, is a clear error before any probe", async () => {
    const { api, calls } = fakeApi();
    const local = await rejectionOf(
      resolveConnectTarget(
        targetInput(api, { name: "db", servers: [LOCAL_SERVER] }).input,
      ),
    );
    expect(local).toMatchObject({ code: "invalid_usage" });
    expect(local.message).toContain("Only remote MCP servers with a url");

    const remote = await rejectionOf(
      resolveConnectTarget(
        targetInput(api, {
          servers: [
            remoteServer("slack", SLACK_URL, {
              client_id: "c",
              redirect_uri: "https://example.test/callback",
            }),
          ],
        }).input,
      ),
    );
    expect(remote.message).toContain("which the CLI can't listen on");
    expect(calls["probe"]).toBeUndefined();
  });

  test("a name in neither the config nor the presets names both sources", async () => {
    const { api } = fakeApi();
    const error = await rejectionOf(
      resolveConnectTarget(targetInput(api, { name: "nope" }).input),
    );
    expect(error).toMatchObject({ code: "invalid_usage" });
    expect(error.message).toContain("MCP config");
    expect(error.message).toContain("--preset <key> (one of: notion)");
  });

  test("a config entry pointing at a preset's server without a client ID uses the preset", async () => {
    const { api, calls } = fakeApi();
    const { input } = targetInput(api, {
      name: "notion",
      servers: [remoteServer("notion", "https://mcp.notion.test/mcp/")],
    });

    const target = await resolveConnectTarget(input);

    expect(target).toEqual({
      kind: "connect",
      preset: "notion",
      name: "notion",
      suppliedRedirectUri: null,
    });
    expect(calls["probe"]).toBeUndefined();
  });

  test("--preset ignores the config", async () => {
    const { api } = fakeApi();
    const { input } = targetInput(api, {
      preset: "notion",
      servers: [remoteServer("slack", SLACK_URL)],
    });

    expect(await resolveConnectTarget(input)).toMatchObject({
      kind: "connect",
      preset: "notion",
      name: "slack",
    });
  });
});

describe("createConnectionsApi probe", () => {
  test("CLIENT_REQUIRED tells the user to add oauth.clientId to their MCP config", async () => {
    const client = {
      connections: {
        probeManagedMcpServer: () =>
          Promise.resolve({
            data: undefined,
            error: {
              code: "MANAGED_CONNECTION_CLIENT_REQUIRED",
              detail: "needs a client",
            },
          }),
      },
    } as unknown as ReturnType<typeof createScarnClient>;

    const error = await rejectionOf(
      createConnectionsApi(client).probe({
        projectId: PROJECT_ID,
        resource: SLACK_URL,
      }),
    );

    expect(error).toMatchObject({ code: "connection_client_required" });
    expect(error.message).toBe(CLIENT_REQUIRED_MESSAGE);
    expect(error.message).toContain("oauth.clientId");
  });
});
