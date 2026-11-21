import { describe, expect, test } from "bun:test";
import {
  buildMcpToolLock,
  parseMcpToolLock,
  serializeMcpToolLock,
} from "../../src/mcp-tools/codegen";
import { LISTED_AT, notionListedTools } from "./fixtures";

describe("buildMcpToolLock", () => {
  test("sorts tools by name and records the listing time", () => {
    const lock = buildMcpToolLock({
      server: "notion",
      listedAt: new Date(LISTED_AT),
      tools: notionListedTools,
    });
    expect(lock.listedAt).toBe(LISTED_AT);
    expect(lock.tools.map((tool) => tool.name)).toEqual([
      "notion-create-pages",
      "notion-search",
    ]);
    expect(lock.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("keeps the hash when a re-list changes only the time, tool order or key order", () => {
    const first = buildMcpToolLock({
      server: "notion",
      listedAt: LISTED_AT,
      tools: notionListedTools,
    });
    const reordered = [...notionListedTools].reverse().map((tool) => ({
      outputSchema: tool.outputSchema,
      inputSchema: Object.fromEntries(
        Object.entries(tool.inputSchema).reverse(),
      ),
      description: tool.description,
      title: tool.title,
      name: tool.name,
    }));
    const second = buildMcpToolLock({
      server: "notion",
      listedAt: "2026-12-01T00:00:00.000Z",
      tools: reordered,
    });
    expect(second.hash).toBe(first.hash);
  });

  test("changes the hash when a schema changes", () => {
    const first = buildMcpToolLock({
      server: "notion",
      listedAt: LISTED_AT,
      tools: notionListedTools,
    });
    const changed = buildMcpToolLock({
      server: "notion",
      listedAt: LISTED_AT,
      tools: notionListedTools.map((tool) => ({
        ...tool,
        description: `${tool.description ?? ""}!`,
      })),
    });
    expect(changed.hash).not.toBe(first.hash);
  });

  test("keeps only the tool's name, title, description and schemas", () => {
    const lock = buildMcpToolLock({
      server: "s",
      listedAt: LISTED_AT,
      tools: [
        {
          name: "t",
          inputSchema: { type: "object" },
          readOnlyHint: true,
          token: "secret",
        } as Parameters<typeof buildMcpToolLock>[0]["tools"][number],
      ],
    });
    expect(lock.tools).toEqual([
      { name: "t", inputSchema: { type: "object" } },
    ]);
    expect(serializeMcpToolLock(lock)).not.toContain("secret");
  });

  test("rejects a tool listed twice", () => {
    expect(() =>
      buildMcpToolLock({
        server: "s",
        listedAt: LISTED_AT,
        tools: [
          { name: "t", inputSchema: {} },
          { name: "t", inputSchema: {} },
        ],
      }),
    ).toThrow('listed the tool "t" twice');
  });
});

describe("parseMcpToolLock", () => {
  const lock = buildMcpToolLock({
    server: "notion",
    listedAt: LISTED_AT,
    tools: notionListedTools,
  });

  test("round-trips a serialized lock", () => {
    const text = serializeMcpToolLock(lock);
    expect(text.endsWith("}\n")).toBe(true);
    expect(parseMcpToolLock(text)).toEqual(lock);
  });

  test("rejects a lock whose content no longer matches its hash", () => {
    const tampered = serializeMcpToolLock(lock).replace(
      "Search the workspace",
      "Search everything",
    );
    expect(() => parseMcpToolLock(tampered)).toThrow("content hashes to");
  });

  test("rejects malformed JSON and unknown fields", () => {
    expect(() => parseMcpToolLock("{")).toThrow("not valid JSON");
    expect(() =>
      parseMcpToolLock(JSON.stringify({ ...lock, extra: true })),
    ).toThrow("malformed");
  });
});
