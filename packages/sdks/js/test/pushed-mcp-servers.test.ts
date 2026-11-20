import { describe, expect, test } from "bun:test";
import type { StepDefinitionSpec } from "../src/definitions/steps";
import type { OpenCodeMcpServers } from "../src/opencode-mcp";
import { pushedMcpServers } from "../src/push/pushed-mcp-servers";

const NOTION_URL = "https://mcp.notion.com/mcp";
const auth = { connection: "notion" } as const;

const step = (key: string, opencodeMcpJson: OpenCodeMcpServers | null) =>
  ({ key, opencodeMcpJson }) as unknown as StepDefinitionSpec;

describe("pushedMcpServers", () => {
  test("records each ref and remote with its step, key, connection and URL or lookup name", () => {
    expect(
      pushedMcpServers([
        step("read", { notion: { type: "ref", auth } }),
        step("docs", {
          acme: {
            type: "remote",
            url: "https://docs.acme.test/mcp",
            auth: { connection: "acme-docs" },
          },
          db: { type: "ref", name: "postgres", disabled: false },
        }),
      ]),
    ).toEqual([
      {
        step: "read",
        key: "notion",
        connection: "notion",
        type: "ref",
        name: "notion",
      },
      {
        step: "docs",
        key: "acme",
        connection: "acme-docs",
        type: "remote",
        url: "https://docs.acme.test/mcp",
      },
      {
        step: "docs",
        key: "db",
        connection: null,
        type: "ref",
        name: "postgres",
        disabled: false,
      },
    ]);
  });

  test("records an enabled remote without auth with its URL", () => {
    expect(
      pushedMcpServers([
        step("plain", { notion: { type: "remote", url: NOTION_URL } }),
      ]),
    ).toEqual([
      {
        step: "plain",
        key: "notion",
        connection: null,
        type: "remote",
        url: NOTION_URL,
      },
    ]);
  });

  test("ignores disabled servers, local servers and steps without MCPs", () => {
    expect(
      pushedMcpServers([
        step("none", null),
        step("off", {
          notion: { type: "ref", auth, disabled: true },
          plain: { type: "remote", url: NOTION_URL, disabled: true },
        }),
        step("local", { local: { type: "local", command: ["x"] } }),
      ]),
    ).toEqual([]);
  });
});
