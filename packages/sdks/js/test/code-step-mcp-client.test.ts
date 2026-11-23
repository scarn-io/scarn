import { describe, expect, expectTypeOf, test } from "bun:test";
import {
  MCP_BRIDGE_CALL_PATH,
  MCP_BRIDGE_TOKEN_ENV,
  MCP_BRIDGE_URL_ENV,
  mcpBridgeCallRequestSchema,
  type McpBridgeCallResponse,
} from "../src/contracts/mcp-bridge";
import {
  createCodeStepMcpClient,
  defineMcp,
  isStepError,
  McpArgsError,
  McpOutputInvalidError,
  McpTimeoutError,
  McpToolError,
  McpUnavailableError,
  StepError,
  type McpBridgeFetch,
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

const ENV = {
  [MCP_BRIDGE_URL_ENV]: "http://host.docker.internal:4555/",
  [MCP_BRIDGE_TOKEN_ENV]: "secret-token",
};

type Recorded = { url: string; init: RequestInit };

function sentBody(call: Recorded | undefined): unknown {
  if (typeof call?.init.body !== "string")
    throw new Error("expected a JSON body");
  return JSON.parse(call.init.body);
}

function fakeFetch(respond: () => Response | Promise<Response>): {
  fetch: McpBridgeFetch;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return await respond();
    },
  };
}

function outcome(body: McpBridgeCallResponse): Response {
  return Response.json(body);
}

function client(respond: () => Response | Promise<Response>) {
  const recorder = fakeFetch(respond);
  const mcp = createCodeStepMcpClient(
    { notion },
    { env: ENV, fetch: recorder.fetch },
  );
  return { mcp, calls: recorder.calls };
}

describe("createCodeStepMcpClient: types", () => {
  test("catalog tools are typed from the catalog, call is untyped", () => {
    const mcp = createCodeStepMcpClient({ notion }, { env: ENV });
    expectTypeOf(mcp).toEqualTypeOf<McpClients<{ notion: typeof notion }>>();
    type Notion = typeof mcp.notion;
    expectTypeOf<Parameters<Notion["search"]>[0]>().toEqualTypeOf<{
      query: string;
      limit?: number | undefined;
    }>();
    expectTypeOf<Awaited<ReturnType<Notion["search"]>>>().toEqualTypeOf<{
      results: { title: string }[];
    }>();
    expectTypeOf<
      Awaited<ReturnType<Notion["createPages"]>>
    >().toEqualTypeOf<McpToolContentResult>();
    expectTypeOf<
      Awaited<ReturnType<Notion["call"]>>
    >().toEqualTypeOf<McpToolContentResult>();
  });

  test("a handle with no catalog only has call", () => {
    const plain = defineMcp({
      type: "remote",
      name: "plain",
      url: "https://x",
    });
    const mcp = createCodeStepMcpClient({ plain }, { env: ENV });
    expectTypeOf<keyof typeof mcp.plain>().toEqualTypeOf<"call">();
    expect(Object.keys(mcp.plain)).toEqual(["call"]);
  });
});

describe("createCodeStepMcpClient: requests", () => {
  test("posts the parsed args to the bridge with the bearer token", async () => {
    const { mcp, calls } = client(() =>
      outcome({
        status: "ok",
        content: [{ type: "text", text: "{}" }],
        structuredContent: { results: [{ title: "Q3" }] },
      }),
    );
    const result = await mcp.notion.search(
      { query: "q3" },
      { timeoutMs: 5000 },
    );
    expect(result).toEqual({ results: [{ title: "Q3" }] });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe(
      `http://host.docker.internal:4555${MCP_BRIDGE_CALL_PATH}`,
    );
    expect(call?.init.method).toBe("POST");
    expect(
      (call?.init.headers as Record<string, string>)["authorization"],
    ).toBe("Bearer secret-token");
    const body = mcpBridgeCallRequestSchema.parse(sentBody(call));
    expect(body).toEqual({
      server: "notion",
      tool: "notion-search",
      args: { query: "q3" },
      timeoutMs: 5000,
    });
  });

  test("a tool with no output schema returns the content result", async () => {
    const content = [{ type: "text", text: "created" }];
    const { mcp } = client(() =>
      outcome({ status: "ok", content, structuredContent: null }),
    );
    const result = await mcp.notion.createPages({
      parent: { page_id: "p" },
      pages: [{ title: "t", content: "c" }],
    });
    expect(result).toEqual({ content, structuredContent: null });
  });

  test("call sends the raw tool name and args unvalidated", async () => {
    const { mcp, calls } = client(() =>
      outcome({ status: "ok", content: [], structuredContent: { a: 1 } }),
    );
    const result = await mcp.notion.call("notion-fetch", { id: 7 });
    expect(result).toEqual({ content: [], structuredContent: { a: 1 } });
    expect(sentBody(calls[0])).toEqual({
      server: "notion",
      tool: "notion-fetch",
      args: { id: 7 },
    });
  });

  test("the signal aborts the fetch", async () => {
    const controller = new AbortController();
    const mcp = createCodeStepMcpClient(
      { notion },
      {
        env: ENV,
        fetch: (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => {
              reject(new Error("fetch aborted"));
            });
          }),
      },
    );
    const pending = mcp.notion.search(
      { query: "q" },
      { signal: controller.signal },
    );
    controller.abort(new Error("cancelled by test"));
    expect((await failure(pending)).message).toBe("cancelled by test");
  });

  test("the env is read lazily, on the first call", async () => {
    const env: Record<string, string | undefined> = {};
    const { fetch } = fakeFetch(() =>
      outcome({ status: "ok", content: [], structuredContent: null }),
    );
    const mcp = createCodeStepMcpClient({ notion }, { env, fetch });
    Object.assign(env, ENV);
    expect(await mcp.notion.call("x")).toEqual({
      content: [],
      structuredContent: null,
    });
  });
});

describe("createCodeStepMcpClient: validation", () => {
  test("args that don't match the catalog throw McpArgsError before sending", async () => {
    const { mcp, calls } = client(() => {
      throw new Error("must not be called");
    });
    const error = await failure(mcp.notion.search({ query: 42 } as never));
    expect(error).toBeInstanceOf(McpArgsError);
    expect((error as McpArgsError).name).toBe("Scarn.ArgsError");
    expect(calls).toHaveLength(0);
  });

  test("a non-integer timeoutMs throws McpArgsError", async () => {
    const { mcp } = client(() => {
      throw new Error("must not be called");
    });
    expect(
      await failure(mcp.notion.call("x", {}, { timeoutMs: -1 })),
    ).toBeInstanceOf(McpArgsError);
  });

  test("missing structuredContent throws McpOutputInvalidError", async () => {
    const { mcp } = client(() =>
      outcome({ status: "ok", content: [], structuredContent: null }),
    );
    expect(await failure(mcp.notion.search({ query: "q" }))).toBeInstanceOf(
      McpOutputInvalidError,
    );
  });

  test("structuredContent that doesn't match the output throws McpOutputInvalidError", async () => {
    const { mcp } = client(() =>
      outcome({
        status: "ok",
        content: [],
        structuredContent: { results: [{ title: 1 }] },
      }),
    );
    const error = await failure(mcp.notion.search({ query: "q" }));
    expect(error).toBeInstanceOf(McpOutputInvalidError);
    expect((error as StepError).name).toBe("Scarn.McpOutputInvalid");
  });
});

describe("createCodeStepMcpClient: outcomes", () => {
  test("tool_error throws McpToolError with the content", async () => {
    const content = [{ type: "text", text: "page not found" }];
    const { mcp } = client(() => outcome({ status: "tool_error", content }));
    const error = await failure(mcp.notion.search({ query: "q" }));
    expect(error).toBeInstanceOf(McpToolError);
    expect(error).toBeInstanceOf(StepError);
    expect(isStepError(error)).toBe(true);
    expect((error as McpToolError).name).toBe("Scarn.McpToolError");
    expect((error as McpToolError).content).toEqual(content);
    expect((error as McpToolError).message).toContain("page not found");
  });

  test("unavailable throws McpUnavailableError with reason and detail", async () => {
    const { mcp } = client(() =>
      outcome({
        status: "unavailable",
        reason: "start",
        detail: "npx: not found",
      }),
    );
    const error = await failure(mcp.notion.search({ query: "q" }));
    expect(error).toBeInstanceOf(McpUnavailableError);
    expect((error as McpUnavailableError).name).toBe("Scarn.McpUnavailable");
    expect((error as McpUnavailableError).reason).toBe("start");
    expect((error as McpUnavailableError).detail).toBe("npx: not found");
  });

  test("timeout throws McpTimeoutError", async () => {
    const { mcp } = client(() => outcome({ status: "timeout" }));
    const error = await failure(mcp.notion.search({ query: "q" }));
    expect(error).toBeInstanceOf(McpTimeoutError);
    expect((error as McpTimeoutError).name).toBe("Scarn.Timeout");
  });

  test.each([
    [404, McpUnavailableError, "not_declared"],
    [401, McpUnavailableError, "bridge"],
    [500, McpUnavailableError, "bridge"],
  ] as const)(
    "HTTP %d throws McpUnavailableError",
    async (status, errorClass, reason) => {
      const { mcp } = client(() =>
        Response.json({ error: "nope" }, { status }),
      );
      const error = await failure(mcp.notion.call("x"));
      expect(error).toBeInstanceOf(errorClass);
      expect((error as McpUnavailableError).reason).toBe(reason);
    },
  );

  test.each([400, 413])("HTTP %d throws McpArgsError", async (status) => {
    const { mcp } = client(() => Response.json({ error: "bad" }, { status }));
    expect(await failure(mcp.notion.call("x"))).toBeInstanceOf(McpArgsError);
  });

  test("a malformed bridge response throws McpUnavailableError", async () => {
    const { mcp } = client(() => Response.json({ status: "weird" }));
    const error = await failure(mcp.notion.call("x"));
    expect(error).toBeInstanceOf(McpUnavailableError);
    expect((error as McpUnavailableError).reason).toBe("bridge");
  });

  test("a network failure throws McpUnavailableError", async () => {
    const mcp = createCodeStepMcpClient(
      { notion },
      {
        env: ENV,
        fetch: () => Promise.reject(new Error("ECONNREFUSED")),
      },
    );
    const error = await failure(mcp.notion.call("x"));
    expect(error).toBeInstanceOf(McpUnavailableError);
    expect((error as McpUnavailableError).detail).toBe("ECONNREFUSED");
  });
});

describe("createCodeStepMcpClient: outside a run", () => {
  test("every call throws McpUnavailableError pointing at createFakeMcpClients", async () => {
    const mcp = createCodeStepMcpClient(
      { notion },
      {
        env: {},
        fetch: () => {
          throw new Error("must not be called");
        },
      },
    );
    for (const pending of [
      mcp.notion.search({ query: "q" }),
      mcp.notion.call("x"),
    ]) {
      const error = await failure(pending);
      expect(error).toBeInstanceOf(McpUnavailableError);
      expect((error as McpUnavailableError).reason).toBe("no_bridge");
      expect(error.message).toContain("createFakeMcpClients");
    }
  });
});

describe("StepError", () => {
  test("carries name, code and the brand", () => {
    const error = new StepError("Acme.NotFound", "missing", { code: "E404" });
    expect(error.name).toBe("Acme.NotFound");
    expect(error.code).toBe("E404");
    expect(error.message).toBe("missing");
    expect(Reflect.get(error, Symbol.for("scarn.stepError"))).toBe(true);
    expect(isStepError(error)).toBe(true);
  });

  test("isStepError recognises the brand, not the class", () => {
    const foreign = Object.assign(new Error("x"), {
      name: "Acme.Other",
      [Symbol.for("scarn.stepError")]: true,
    });
    expect(isStepError(foreign)).toBe(true);
    expect(isStepError(new Error("x"))).toBe(false);
    expect(isStepError(null)).toBe(false);
  });
});
