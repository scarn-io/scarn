import { describe, expect, expectTypeOf, test } from "bun:test";
import {
  createFakeMcpClients,
  defineMcp,
  McpArgsError,
  McpOutputInvalidError,
  McpTimeoutError,
  McpToolError,
  McpUnavailableError,
  type FakeMcpClients,
  type McpClients,
} from "../src/definitions/steps";
import type { McpToolContentResult } from "../src/pipelines";
import { notion } from "./mcp-tool-step-fixtures";

async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error("expected the call to fail");
}

const mcps = { notion };

describe("createFakeMcpClients: types", () => {
  test("returns McpClients typed from the same catalog", () => {
    const mcp = createFakeMcpClients(mcps, {});
    expectTypeOf(mcp).toEqualTypeOf<McpClients<typeof mcps>>();
    expectTypeOf<
      Awaited<ReturnType<typeof mcp.notion.search>>
    >().toEqualTypeOf<{
      results: { title: string }[];
    }>();
  });

  test("fakes are typed from the catalog", () => {
    type SearchFake = NonNullable<
      NonNullable<FakeMcpClients<typeof mcps>["notion"]>["search"]
    >;
    expectTypeOf<Parameters<SearchFake>[0]>().toEqualTypeOf<{
      query: string;
      limit?: number | undefined;
    }>();
    createFakeMcpClients(mcps, {
      notion: {
        // @ts-expect-error the result must match the catalog's output
        search: () => ({ results: [{ title: 1 }] }),
      },
    });
    createFakeMcpClients(mcps, {
      notion: {
        // @ts-expect-error not a catalog tool
        fetch: () => ({ content: [], structuredContent: null }),
      },
    });
  });
});

describe("createFakeMcpClients: calls", () => {
  test("a fake gets the parsed args and its result is returned", async () => {
    const seen: unknown[] = [];
    const mcp = createFakeMcpClients(mcps, {
      notion: {
        search: (args) => {
          seen.push(args);
          return { results: [{ title: args.query }] };
        },
      },
    });
    expect(await mcp.notion.search({ query: "q3" })).toEqual({
      results: [{ title: "q3" }],
    });
    expect(seen).toEqual([{ query: "q3" }]);
  });

  test("a fake for a tool with no output returns a content result", async () => {
    const result: McpToolContentResult = {
      content: [{ type: "text", text: "ok" }],
      structuredContent: null,
    };
    const mcp = createFakeMcpClients(mcps, {
      notion: { createPages: () => result },
    });
    expect(
      await mcp.notion.createPages({ parent: { page_id: "p" }, pages: [] }),
    ).toEqual(result);
  });

  test("call uses the server's call fake", async () => {
    const mcp = createFakeMcpClients(mcps, {
      notion: {
        call: (tool, args) => ({
          content: [{ type: "text", text: `${tool}:${JSON.stringify(args)}` }],
          structuredContent: null,
        }),
      },
    });
    expect(await mcp.notion.call("notion-fetch", { id: 1 })).toEqual({
      content: [{ type: "text", text: 'notion-fetch:{"id":1}' }],
      structuredContent: null,
    });
  });
});

describe("createFakeMcpClients: validation", () => {
  test("args that don't match the catalog throw McpArgsError", async () => {
    const mcp = createFakeMcpClients(mcps, {
      notion: { search: () => ({ results: [] }) },
    });
    expect(
      await failure(mcp.notion.search({ query: 1 } as never)),
    ).toBeInstanceOf(McpArgsError);
  });

  test("a result that doesn't match the output throws McpOutputInvalidError", async () => {
    const mcp = createFakeMcpClients(mcps, {
      notion: { search: () => ({ results: "nope" }) as never },
    });
    expect(await failure(mcp.notion.search({ query: "q" }))).toBeInstanceOf(
      McpOutputInvalidError,
    );
  });

  test("a result that isn't a content result throws McpOutputInvalidError", async () => {
    const mcp = createFakeMcpClients(mcps, {
      notion: { call: () => ({ nope: true }) as never },
    });
    expect(await failure(mcp.notion.call("x"))).toBeInstanceOf(
      McpOutputInvalidError,
    );
  });
});

describe("createFakeMcpClients: missing fakes", () => {
  test("a tool with no fake throws McpUnavailableError", async () => {
    const mcp = createFakeMcpClients(mcps, {
      notion: { search: () => ({ results: [] }) },
    });
    const error = await failure(
      mcp.notion.createPages({ parent: { page_id: "p" }, pages: [] }),
    );
    expect(error).toBeInstanceOf(McpUnavailableError);
    expect((error as McpUnavailableError).reason).toBe("no_fake");
    expect(error.message).toContain("notion.createPages");
  });

  test("call with no call fake throws McpUnavailableError", async () => {
    const plain = defineMcp({
      type: "remote",
      name: "plain",
      url: "https://x",
    });
    const mcp = createFakeMcpClients({ plain });
    expect(await failure(mcp.plain.call("x"))).toBeInstanceOf(
      McpUnavailableError,
    );
  });
});

describe("createFakeMcpClients: thrown errors", () => {
  test.each([
    ["McpToolError", () => new McpToolError("boom", [{ type: "text" }])],
    [
      "McpUnavailableError",
      () => new McpUnavailableError("down", "connect", "x"),
    ],
    ["McpTimeoutError", () => new McpTimeoutError("slow")],
    ["McpOutputInvalidError", () => new McpOutputInvalidError("bad")],
    ["McpArgsError", () => new McpArgsError("bad args")],
  ] as const)("a fake can throw %s", async (_label, make) => {
    const thrown = make();
    const mcp = createFakeMcpClients(mcps, {
      notion: {
        search: () => {
          throw thrown;
        },
      },
    });
    expect(await failure(mcp.notion.search({ query: "q" }))).toBe(thrown);
  });
});
