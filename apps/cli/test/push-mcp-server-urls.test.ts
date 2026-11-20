import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscoveredAgentTools, DiscoveredMcpServer } from "@scarn/worker";
import {
  readPushedMcpServers,
  resolvePushedMcpServerUrls,
  type PushedMcpServer,
} from "../src/lib/push-mcp-server-urls";

const NOTION_URL = "https://mcp.notion.com/mcp";

const discovered = (
  name: string,
  config: DiscoveredMcpServer["config"],
): DiscoveredMcpServer => ({
  name,
  source: ".mcp.json",
  transport: config.type,
  config,
  requiredEnv: [],
  inlineSecrets: [],
  shadowed: [],
});

const tools = (servers: DiscoveredMcpServer[]): DiscoveredAgentTools => ({
  servers,
  skills: [],
  skipped: [],
  searched: [],
});

const ref = (overrides: Partial<PushedMcpServer> = {}): PushedMcpServer =>
  ({
    type: "ref",
    step: "read",
    key: "docs",
    connection: "notion",
    name: "notion",
    ...overrides,
  }) as PushedMcpServer;

describe("resolvePushedMcpServerUrls", () => {
  test("a remote keeps its own URL", () => {
    expect(
      resolvePushedMcpServerUrls(
        [
          {
            type: "remote",
            step: "read",
            key: "docs",
            connection: null,
            url: NOTION_URL,
          },
        ],
        null,
      ),
    ).toEqual([
      { step: "read", key: "docs", connection: null, url: NOTION_URL },
    ]);
  });

  test("a ref takes the URL of the repository server it names", () => {
    expect(
      resolvePushedMcpServerUrls(
        [ref({ key: "docs", name: "notion" })],
        tools([discovered("notion", { type: "remote", url: NOTION_URL })]),
      ),
    ).toEqual([
      { step: "read", key: "docs", connection: "notion", url: NOTION_URL },
    ]);
  });

  test("a ref the repository doesn't define as a remote, or that couldn't be read, has no URL", () => {
    const servers = [
      ref({ key: "a", name: "missing" }),
      ref({ key: "b", name: "local" }),
    ];
    const repo = tools([
      discovered("local", { type: "local", command: ["x"] }),
    ]);
    expect(
      resolvePushedMcpServerUrls(servers, repo).map(({ url }) => url),
    ).toEqual([null, null]);
    expect(
      resolvePushedMcpServerUrls(servers, null).map(({ url }) => url),
    ).toEqual([null, null]);
  });

  test("a ref whose repository definition is disabled is dropped unless the ref enables it", () => {
    const repo = tools([
      discovered("notion", { type: "remote", url: NOTION_URL, disabled: true }),
    ]);
    expect(resolvePushedMcpServerUrls([ref()], repo)).toEqual([]);
    expect(
      resolvePushedMcpServerUrls([ref({ disabled: false })], repo),
    ).toHaveLength(1);
  });
});

describe("readPushedMcpServers", () => {
  test("reads the servers the push script wrote, or [] when unreadable", () => {
    const dir = mkdtempSync(join(tmpdir(), "scarn-push-status-"));
    try {
      const path = join(dir, "result.json");
      expect(readPushedMcpServers(path)).toEqual([]);
      const servers = [
        ref(),
        {
          type: "remote",
          step: "read",
          key: "plain",
          connection: null,
          url: NOTION_URL,
        },
      ];
      writeFileSync(path, JSON.stringify({ mcpServers: servers }));
      expect(readPushedMcpServers(path)).toEqual(servers as PushedMcpServer[]);
      writeFileSync(
        path,
        JSON.stringify({ mcpServers: [ref({ connection: "Not A Name" })] }),
      );
      expect(readPushedMcpServers(path)).toEqual([]);
      writeFileSync(path, "not json");
      expect(readPushedMcpServers(path)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
