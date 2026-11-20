import { describe, expect, test } from "bun:test";
import {
  managedConnectionNameSchema,
  normalizeMcpResourceUrl,
} from "../src/managed-connections";

describe("normalizeMcpResourceUrl", () => {
  test("ignores the case of scheme and host, a default port and a trailing slash", () => {
    for (const url of [
      "https://mcp.notion.com/mcp",
      "HTTPS://MCP.Notion.COM/mcp",
      "https://mcp.notion.com:443/mcp",
      "https://mcp.notion.com/mcp/",
    ]) {
      expect(normalizeMcpResourceUrl(url)).toBe("https://mcp.notion.com/mcp");
    }
  });

  test("keeps a different path, port or scheme distinct", () => {
    for (const url of [
      "https://mcp.notion.com/MCP",
      "https://mcp.notion.com/mcp/sse",
      "https://mcp.notion.com:8443/mcp",
      "http://mcp.notion.com/mcp",
      "https://notion.com/mcp",
    ]) {
      expect(normalizeMcpResourceUrl(url)).not.toBe(
        "https://mcp.notion.com/mcp",
      );
    }
  });

  test("rejects query strings, fragments, credentials and non-URLs", () => {
    for (const url of [
      "https://mcp.notion.com/mcp?x=1",
      "https://mcp.notion.com/mcp?",
      "https://mcp.notion.com/mcp#frag",
      "https://user:pw@mcp.notion.com/mcp",
      "mcp.notion.com/mcp",
      "ftp://mcp.notion.com/mcp",
    ]) {
      expect(normalizeMcpResourceUrl(url)).toBeNull();
    }
  });
});

describe("managedConnectionNameSchema", () => {
  test("accepts lowercase kebab-case names of 1–63 characters", () => {
    for (const name of [
      "notion",
      "acme-docs",
      "a",
      "a1-b2-c3",
      "a".repeat(63),
    ]) {
      expect(managedConnectionNameSchema.safeParse(name).success).toBe(true);
    }
  });

  test("rejects anything else", () => {
    for (const name of [
      "",
      "Notion",
      "a_b",
      "a b",
      "-a",
      "a-",
      "a--b",
      "a".repeat(64),
    ]) {
      expect(managedConnectionNameSchema.safeParse(name).success).toBe(false);
    }
  });
});
