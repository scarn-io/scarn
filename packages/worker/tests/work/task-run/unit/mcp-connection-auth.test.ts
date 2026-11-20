/**
 * Connection auth on a step's MCP servers (slice 3): a `ref` or inline
 * `remote` with `auth: { connection }` must resolve to a `remote`, loses its
 * definition's `headers`/`oauth` and their variables, and is recorded in
 * `connectionAuth`. Its URL is not checked here: the server checks it
 * against the connection's resource. A server without `auth` passes through
 * untouched, whatever its URL. Launches: `launch-mcp-connection-auth.test.ts`.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { OpenCodeMcpServers } from "../../../../src/common/contracts/opencode-mcp";
import { discoverRepoAgentTools } from "../../../../src/project/agent-tools/infra/discover-repo-agent-tools";
import { buildTaskRunFailurePayload } from "../../../../src/work/task-run/application/build-task-run-failure-payload";
import {
  planStepEnv,
  stepMcpServersAddEnv,
  withInferredMcpEnv,
} from "../../../../src/work/task-run/application/resolve-step-env";
import { ManagedConnectionNotReadyError } from "../../../../src/work/task-run/application/managed-connection-not-ready-error";
import { McpConnectionAuthRejectedError } from "../../../../src/work/task-run/application/mcp-connection-auth-rejected-error";
import {
  McpConnectionAuthNotRemoteError,
  resolveStepMcpServers,
} from "../../../../src/work/task-run/infra/mcp-server-ref-resolver";

const NOTION_URL = "https://mcp.notion.com/mcp";
const TOKEN_VAR = "NOTION_TOKEN";

function thrownBy(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error("expected the call to throw");
}

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(path.join(os.tmpdir(), "mcp-connection-auth-"));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

async function writeRepoServers(servers: Record<string, object>) {
  await mkdir(path.join(workspace, ".opencode"), { recursive: true });
  await writeFile(
    path.join(workspace, ".opencode", "opencode.json"),
    JSON.stringify({ mcp: { servers } }),
  );
}

const repoNotion = {
  type: "remote" as const,
  url: NOTION_URL,
  headers: {
    Authorization: `Bearer {env:${TOKEN_VAR}}`,
    "X-Trace": "{env:NOTION_TRACE}",
  },
  oauth: { scope: "read" },
};

const resolveWith = async (servers: OpenCodeMcpServers) =>
  resolveStepMcpServers({
    servers,
    tools: await discoverRepoAgentTools(workspace),
  });

const resolveError = async (servers: OpenCodeMcpServers) => {
  const tools = await discoverRepoAgentTools(workspace);
  return thrownBy(() => resolveStepMcpServers({ servers, tools }));
};

describe("resolveStepMcpServers with connection auth", () => {
  test("a ref with auth drops the definition's headers and oauth, and their variables", async () => {
    await writeRepoServers({ notion: repoNotion });

    const result = await resolveWith({
      docs: { type: "ref", name: "notion", auth: { connection: "notion" } },
    });

    expect(result.servers).toEqual({
      docs: { type: "remote", url: NOTION_URL },
      notion: { ...repoNotion, disabled: true },
    });
    expect(result.resolvedRefs).toEqual([
      {
        key: "docs",
        lookupName: "notion",
        source: ".opencode/opencode.json",
        type: "remote",
        inlineSecrets: [],
        requiredEnv: [],
      },
    ]);
    expect(result.connectionAuth).toEqual([
      {
        key: "docs",
        connection: "notion",
        url: NOTION_URL,
        source: ".opencode/opencode.json",
        droppedHeaders: ["Authorization", "X-Trace"],
        droppedOAuth: true,
      },
    ]);
  });

  test("a ref with auth keeps its shared fields", async () => {
    await writeRepoServers({ notion: repoNotion });

    const { servers } = await resolveWith({
      notion: {
        type: "ref",
        auth: { connection: "notion" },
        timeout: { startup: 5000 },
      },
    });

    expect(servers?.["notion"]).toEqual({
      type: "remote",
      url: NOTION_URL,
      timeout: { startup: 5000 },
    });
  });

  test("a ref with auth to a local definition fails naming the key, source and a fix", async () => {
    await writeRepoServers({
      notion: { type: "local", command: ["npx", "mcp-remote", NOTION_URL] },
    });

    const error = await resolveError({
      notion: { type: "ref", auth: { connection: "notion" } },
    });

    expect(error).toBeInstanceOf(McpConnectionAuthNotRemoteError);
    expect(error.message).toContain('MCP server "notion"');
    expect(error.message).toContain(".opencode/opencode.json");
    expect(error.message).toContain("local server");
    expect(error.message).toContain('the project\'s "notion" connection');
    expect(error.message).toContain("remote server with the connection's URL");
    expect(error.message).toContain('defineMcp({ type: "remote"');
  });

  test("a ref with auth to any URL resolves, leaving the URL check to the server", async () => {
    const proxyUrl = "https://notion-proxy.example.com/mcp";
    await writeRepoServers({ notion: { type: "remote", url: proxyUrl } });

    const { servers, connectionAuth } = await resolveWith({
      notion: { type: "ref", auth: { connection: "acme-docs" } },
    });

    expect(servers?.["notion"]).toEqual({ type: "remote", url: proxyUrl });
    expect(
      connectionAuth.map(({ key, connection }) => [key, connection]),
    ).toEqual([["notion", "acme-docs"]]);
  });

  test("an inline remote with auth never carries auth into the resolved config", async () => {
    const { servers, connectionAuth } = await resolveWith({
      notion: {
        type: "remote",
        url: NOTION_URL,
        auth: { connection: "notion" },
      },
    });

    expect(servers).toEqual({ notion: { type: "remote", url: NOTION_URL } });
    expect(connectionAuth).toEqual([
      {
        key: "notion",
        connection: "notion",
        url: NOTION_URL,
        source: "the step definition",
        droppedHeaders: [],
        droppedOAuth: false,
      },
    ]);
  });

  test("disabled entries and local servers are recorded in neither list", async () => {
    const { connectionAuth, remotesWithoutAuth } = await resolveWith({
      notion: {
        type: "remote",
        url: NOTION_URL,
        auth: { connection: "notion" },
        disabled: true,
      },
      plain: { type: "remote", url: NOTION_URL, disabled: true },
      tool: { type: "local", command: ["mcp-tool"] },
    });

    expect(connectionAuth).toEqual([]);
    expect(remotesWithoutAuth).toEqual([]);
  });

  test("a ref without auth at a connection-like URL passes through untouched", async () => {
    await writeRepoServers({ notion: { type: "remote", url: NOTION_URL } });

    const { servers, connectionAuth, remotesWithoutAuth } = await resolveWith({
      notion: { type: "ref" },
    });

    expect(servers).toEqual({ notion: { type: "remote", url: NOTION_URL } });
    expect(connectionAuth).toEqual([]);
    expect(remotesWithoutAuth).toEqual([{ key: "notion", url: NOTION_URL }]);
  });

  test("an inline remote without auth at a connection-like URL passes through untouched", async () => {
    const { servers, connectionAuth, remotesWithoutAuth } = await resolveWith({
      notion: { type: "remote", url: NOTION_URL },
    });

    expect(servers).toEqual({ notion: { type: "remote", url: NOTION_URL } });
    expect(connectionAuth).toEqual([]);
    expect(remotesWithoutAuth).toEqual([{ key: "notion", url: NOTION_URL }]);
  });

  test("a ref without auth but with the user's own Authorization header passes through", async () => {
    await writeRepoServers({
      notion: {
        type: "remote",
        url: NOTION_URL,
        headers: { authorization: `Bearer {env:${TOKEN_VAR}}` },
      },
    });

    const { servers, resolvedRefs, connectionAuth } = await resolveWith({
      notion: { type: "ref" },
    });

    expect(servers?.["notion"]).toEqual({
      type: "remote",
      url: NOTION_URL,
      headers: { authorization: `Bearer {env:${TOKEN_VAR}}` },
    });
    expect(resolvedRefs[0]?.requiredEnv).toEqual([TOKEN_VAR]);
    expect(connectionAuth).toEqual([]);
  });

  test("an unused repository server at a connection-like URL is disabled", async () => {
    await writeRepoServers({ notion: { type: "remote", url: NOTION_URL } });

    const { disabledServers } = await resolveWith({});

    expect(disabledServers).toEqual(["notion"]);
  });
});

describe("step env with connection auth", () => {
  test("an auth server adds no variables and doesn't route the prompt env", () => {
    const servers: OpenCodeMcpServers = {
      notion: { type: "ref", auth: { connection: "notion" } },
    };

    expect(stepMcpServersAddEnv(servers)).toBe(false);
    expect(
      withInferredMcpEnv(null, [{ key: "notion", requiredEnv: [] }], servers),
    ).toEqual([]);
    expect(
      planStepEnv({
        envVars: null,
        inputJson: {},
        workerEnv: {},
        opencodeMcpJson: servers,
      }).resolveMcpEnv,
    ).toBeUndefined();
  });

  test("an ordinary ref next to an auth server still adds its variables", () => {
    const servers: OpenCodeMcpServers = {
      notion: { type: "ref", auth: { connection: "notion" } },
      db: { type: "ref" },
    };

    expect(stepMcpServersAddEnv(servers)).toBe(true);
    expect(
      planStepEnv({
        envVars: null,
        inputJson: {},
        workerEnv: {},
        opencodeMcpJson: servers,
      }).resolveMcpEnv,
    ).toBeDefined();
  });
});

describe("failure classification", () => {
  test("names the connection-auth error so the Task shows the message", () => {
    expect(
      buildTaskRunFailurePayload(
        new McpConnectionAuthNotRemoteError({
          key: "notion",
          connection: "notion",
          source: ".mcp.json",
          type: "local",
        }),
      ).errorJson,
    ).toMatchObject({
      name: "Scarn.McpConnectionAuthInvalid",
      code: "SCARN_MCP_CONNECTION_AUTH_INVALID",
    });
  });

  test("names the server's URL refusal the same way, with its detail", () => {
    const detail =
      'MCP server "notion" uses the project\'s "notion" connection, but its URL is not the connection\'s. Point it at https://mcp.notion.com/mcp.';

    expect(
      buildTaskRunFailurePayload(new McpConnectionAuthRejectedError(detail))
        .errorJson,
    ).toMatchObject({
      name: "Scarn.McpConnectionAuthInvalid",
      code: "SCARN_MCP_CONNECTION_AUTH_INVALID",
      message: detail,
    });
  });

  test("reports a not-ready managed connection as ManagedConnectionNotReady with its cause", () => {
    expect(
      buildTaskRunFailurePayload(
        new ManagedConnectionNotReadyError({
          key: "notion",
          connection: "notion",
          label: "Notion",
          state: "needs_reconnect",
          reasonCode: "refresh_failed",
        }),
      ).errorJson,
    ).toEqual({
      name: "ManagedConnectionNotReady",
      code: "MANAGED_CONNECTION_NOT_READY",
      message:
        "The project's Notion connection isn't ready, so the run didn't start; a project admin must reconnect it in project settings. " +
        "It isn't retried automatically: start a new attempt explicitly with Retry in the app, `scarn tasks retry <taskId>`, or `scarn runs rerun <runId> --step <key>` for a pipeline step.",
      cause: {
        key: "notion",
        state: "needs_reconnect",
        reasonCode: "refresh_failed",
      },
    });
  });
});
