import { describe, expect, test } from "bun:test";
import { normalizeMcpServer } from "../../../../src/project/agent-tools/domain/normalize-mcp-server";

const configOf = (result: ReturnType<typeof normalizeMcpServer>) =>
  result.kind === "server" ? result.config : result;

describe("normalizeMcpServer OAuth client settings", () => {
  test("Claude's camelCase oauth keeps clientId, callbackPort and scope", () => {
    const result = normalizeMcpServer({
      format: "claude",
      entry: {
        type: "http",
        url: "https://mcp.slack.com/mcp",
        oauth: {
          clientId: "1601185624273.8899143856786",
          callbackPort: 3118,
          scope: "channels:read chat:write",
        },
      },
    });

    expect(configOf(result)).toEqual({
      type: "remote",
      url: "https://mcp.slack.com/mcp",
      oauth: {
        client_id: "1601185624273.8899143856786",
        callback_port: 3118,
        scope: "channels:read chat:write",
      },
    });
  });

  test("Claude's oauth keeps redirectUri", () => {
    const result = normalizeMcpServer({
      format: "claude",
      entry: {
        type: "http",
        url: "https://mcp.example.test/mcp",
        oauth: {
          clientId: "public-client",
          redirectUri: "http://localhost:4000/callback",
        },
      },
    });

    expect(configOf(result)).toEqual({
      type: "remote",
      url: "https://mcp.example.test/mcp",
      oauth: {
        client_id: "public-client",
        redirect_uri: "http://localhost:4000/callback",
      },
    });
  });

  test("OpenCode v2 oauth passes client_id, redirect_uri and scope through", () => {
    const result = normalizeMcpServer({
      format: "opencode",
      generation: "v2",
      entry: {
        type: "remote",
        url: "https://mcp.example.test/mcp",
        oauth: {
          client_id: "public-client",
          redirect_uri: "http://localhost:4000/callback",
          scope: "read write",
        },
      },
    });

    expect(configOf(result)).toEqual({
      type: "remote",
      url: "https://mcp.example.test/mcp",
      oauth: {
        client_id: "public-client",
        redirect_uri: "http://localhost:4000/callback",
        scope: "read write",
      },
    });
  });

  test("OpenCode v1 camelCase oauth becomes snake_case and keeps scope", () => {
    const result = normalizeMcpServer({
      format: "opencode",
      generation: "v1",
      entry: {
        type: "remote",
        url: "https://mcp.example.test/mcp",
        oauth: { clientId: "public-client", callbackPort: 3118, scope: "read" },
      },
    });

    expect(configOf(result)).toEqual({
      type: "remote",
      url: "https://mcp.example.test/mcp",
      oauth: { client_id: "public-client", callback_port: 3118, scope: "read" },
    });
  });

  test("Cursor and VS Code entries ignore oauth", () => {
    const result = normalizeMcpServer({
      format: "cursor",
      entry: {
        url: "https://mcp.example.test/mcp",
        oauth: { clientId: "public-client" },
      },
    });

    expect(configOf(result)).toEqual({
      type: "remote",
      url: "https://mcp.example.test/mcp",
    });
  });
});
