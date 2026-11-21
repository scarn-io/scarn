import { describe, expect, test } from "bun:test";
import type { DiscoveredMcpServer } from "@scarn/worker";
import type { ConnectionsApi } from "../src/lib/connections-api";
import {
  resolveConnectTarget,
  type ConnectTargetInput,
} from "../src/lib/connections-custom";
import { runLoopbackSignIn } from "../src/lib/connections-loopback";
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
 * Scopes per connection (decision 11): `connect <name>` sends `--scope` or
 * the MCP config's `oauth.scope` with a custom start, and the sign-in shows
 * the scopes granted and any requested one that wasn't.
 */

const FILES_URL = "https://mcp.files.test/mcp";
const NOTION_URL = "https://mcp.notion.test/mcp";

function remoteServer(
  name: string,
  url: string,
  scope?: string,
): DiscoveredMcpServer {
  return {
    name,
    source: ".mcp.json",
    transport: "remote",
    config: {
      type: "remote",
      url,
      ...(scope === undefined ? {} : { oauth: { scope } }),
    },
    requiredEnv: [],
    inlineSecrets: [],
    shadowed: [],
  };
}

function targetInput(
  api: ConnectionsApi,
  overrides: Partial<ConnectTargetInput> = {},
) {
  const recorder = createReporterRecorder();
  const input: ConnectTargetInput = {
    api: {
      ...api,
      listPresets: () =>
        Promise.resolve([
          {
            key: "notion",
            label: "Notion",
            resource: NOTION_URL,
            removalUrl: null,
          },
        ]),
    },
    projectId: PROJECT_ID,
    name: "files",
    preset: undefined,
    scopes: [],
    servers: [],
    skipped: [],
    yes: true,
    reporter: recorder.reporter,
    isTty: true,
    ...overrides,
  };
  return { input, recorder };
}

describe("connect with scopes", () => {
  test("the config's oauth.scope is shown and sent with the custom start", async () => {
    const { api } = fakeApi();
    const { input, recorder } = targetInput(api, {
      servers: [remoteServer("files", FILES_URL, "files:read  files:write")],
    });

    const target = await resolveConnectTarget(input);

    expect(reportedMessages(recorder.calls).join("\n")).toContain(
      "Requests scopes: files:read files:write",
    );
    expect(target).toMatchObject({
      kind: "custom",
      custom: { scopes: ["files:read", "files:write"] },
    });
  });

  test("--scope replaces the config's oauth.scope", async () => {
    const { api } = fakeApi();
    const { input } = targetInput(api, {
      servers: [remoteServer("files", FILES_URL, "files:read")],
      scopes: ["chat:write", "chat:write", "users:read"],
    });

    const target = await resolveConnectTarget(input);

    expect(target).toMatchObject({
      custom: { scopes: ["chat:write", "users:read"] },
    });
  });

  test("without scopes none are sent and the advertised ones are asked for", async () => {
    const { api } = fakeApi();
    const { input, recorder } = targetInput(api, {
      servers: [remoteServer("files", FILES_URL)],
    });

    const target = await resolveConnectTarget(input);

    expect(reportedMessages(recorder.calls).join("\n")).toContain(
      "Requests the scopes the server advertises.",
    );
    expect(target).toMatchObject({ kind: "custom" });
    expect((target as { custom: object }).custom).not.toHaveProperty("scopes");
  });

  test("scopes keep a config entry on a preset's URL custom", async () => {
    const { api } = fakeApi();
    const { input } = targetInput(api, {
      name: "notion",
      servers: [remoteServer("notion", NOTION_URL, "read")],
    });

    expect(await resolveConnectTarget(input)).toMatchObject({
      kind: "custom",
      custom: { scopes: ["read"] },
    });
  });

  test("--scope with a preset is refused", async () => {
    const { api, calls } = fakeApi();

    const byFlag = await rejectionOf(
      resolveConnectTarget(
        targetInput(api, { preset: "notion", scopes: ["read"] }).input,
      ),
    );
    const byName = await rejectionOf(
      resolveConnectTarget(
        targetInput(api, { name: "notion", scopes: ["read"] }).input,
      ),
    );

    for (const error of [byFlag, byName]) {
      expect(error.message).toContain(
        "--scope only applies to a remote server from your MCP config",
      );
    }
    expect(calls["probe"]).toBeUndefined();
  });

  test("the sign-in shows the granted scopes and warns about missing ones", async () => {
    const pending = candidateConnection();
    const { api } = fakeApi({
      ...pending,
      scopes: ["read", "write"],
      candidate: pending.candidate && {
        ...pending.candidate,
        grantedScopes: ["read"],
        missingScopes: ["write"],
      },
    });
    const recorder = createReporterRecorder();

    const outcome = await runLoopbackSignIn({
      ...baseInput,
      yes: true,
      reporter: recorder.reporter,
      ports: ports(api),
    });

    expect(outcome.kind).toBe("confirmed");
    const shown = reportedMessages(recorder.calls).join("\n");
    expect(shown).toContain("Granted scopes: read");
    expect(shown).toContain("Notion didn't grant: write.");
  });

  test("a grant with every scope shows them with no warning", async () => {
    const { api } = fakeApi();
    const recorder = createReporterRecorder();

    await runLoopbackSignIn({
      ...baseInput,
      yes: true,
      reporter: recorder.reporter,
      ports: ports(api),
    });

    const shown = reportedMessages(recorder.calls).join("\n");
    expect(shown).toContain("Granted scopes: read");
    expect(shown).not.toContain("didn't grant");
  });
});
