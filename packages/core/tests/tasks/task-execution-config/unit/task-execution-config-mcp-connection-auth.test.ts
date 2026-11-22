import { describe, expect, test } from "bun:test";
import { storedOpenCodeMcpServersSchema } from "@/common/contracts/stored-opencode-mcp";

describe("stored MCP connection auth", () => {
  test("a connection name that no preset uses round-trips", () => {
    const servers = {
      docs: {
        type: "remote" as const,
        url: "https://docs.acme.test/mcp",
        auth: { connection: "acme-docs" },
      },
      wiki: { type: "ref" as const, auth: { connection: "acme-wiki" } },
    };

    const parsed = storedOpenCodeMcpServersSchema.safeParse(
      JSON.parse(JSON.stringify(servers)),
    );

    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual(servers);
  });

  test("an invalid connection name is rejected", () => {
    for (const connection of ["Acme Docs", "a_b", "", "a".repeat(64)]) {
      expect(
        storedOpenCodeMcpServersSchema.safeParse({
          docs: { type: "ref", auth: { connection } },
        }).success,
      ).toBe(false);
    }
  });
});
