import { describe, expect } from "bun:test";
import {
  GuardedFetch,
  OutboundRequestError,
} from "@/connections/managed-mcp-connection/infra/guarded-fetch";
import { GuardedMcpFetch } from "@/connections/managed-mcp-connection/infra/guarded-mcp-fetch";
import { concurrentTest } from "tests/utils";

const ORIGIN = "https://mcp.notion.com";
const PUBLIC_IP = "104.18.10.10";
const AUTHORIZATION = "Bearer secret-access-token";

type Sent = { url: string; headers: Headers };

const mcpFetch = (
  fetchImpl: (url: URL, init?: RequestInit) => Promise<Response>,
  options: { timeoutMs?: number; maxResponseBytes?: number } = {},
  resolveHost: (host: string) => Promise<string[]> = () =>
    Promise.resolve([PUBLIC_IP]),
) =>
  new GuardedMcpFetch({
    guardedFetch: new GuardedFetch({
      allowedOrigins: [ORIGIN],
      resolveHost,
      fetchImpl: fetchImpl as typeof fetch,
    }),
    ...options,
  });

const recording = (respond: () => Response = () => new Response("{}")) => {
  const sent: Sent[] = [];
  const fetchImpl = (url: URL, init?: RequestInit) => {
    sent.push({ url: url.toString(), headers: new Headers(init?.headers) });
    return Promise.resolve(respond());
  };
  return { sent, fetchImpl };
};

const failureOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof OutboundRequestError) {
      return error.failure;
    }
    throw error;
  }
  throw new Error("expected the request to fail");
};

const stream = (chunks: number, chunkBytes: number) => {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent === chunks) {
        controller.close();
        return;
      }
      sent += 1;
      controller.enqueue(new Uint8Array(chunkBytes));
    },
  });
};

describe("GuardedMcpFetch", () => {
  concurrentTest(
    "never sends the Authorization header to another origin",
    async () => {
      const { sent, fetchImpl } = recording();
      const session = mcpFetch(fetchImpl).session();

      for (const url of [
        "https://evil.example/mcp",
        "http://mcp.notion.com/mcp",
        "https://mcp.notion.com.evil.example/mcp",
        "https://user:pass@mcp.notion.com/mcp",
      ]) {
        expect(
          await failureOf(
            session.fetch(url, {
              method: "POST",
              headers: { Authorization: AUTHORIZATION },
            }),
          ),
        ).toBe("blocked");
      }
      expect(sent).toEqual([]);
      expect(session.failure).toBe("blocked");
    },
  );

  concurrentTest(
    "refuses a host that resolves to a private address",
    async () => {
      const { sent, fetchImpl } = recording();
      const session = mcpFetch(fetchImpl, {}, () =>
        Promise.resolve(["169.254.169.254"]),
      ).session();

      expect(
        await failureOf(
          session.fetch(`${ORIGIN}/mcp`, {
            method: "POST",
            headers: { Authorization: AUTHORIZATION },
          }),
        ),
      ).toBe("blocked");
      expect(sent).toEqual([]);
    },
  );

  concurrentTest(
    "refuses a redirect instead of following it with the token",
    async () => {
      const { sent, fetchImpl } = recording(
        () =>
          new Response("moved", {
            status: 307,
            headers: { location: "https://evil.example/mcp" },
          }),
      );
      const session = mcpFetch(fetchImpl).session();

      expect(
        await failureOf(
          session.fetch(`${ORIGIN}/mcp`, {
            method: "POST",
            headers: { Authorization: AUTHORIZATION },
          }),
        ),
      ).toBe("redirect");
      expect(sent.map((request) => request.url)).toEqual([`${ORIGIN}/mcp`]);
      expect(session.failure).toBe("redirect");
    },
  );

  concurrentTest("streams a response under the cap", async () => {
    const session = mcpFetch(
      () =>
        Promise.resolve(
          new Response(stream(4, 100), {
            headers: { "content-type": "application/json" },
          }),
        ),
      { maxResponseBytes: 1_000 },
    ).session();

    const response = await session.fetch(`${ORIGIN}/mcp`, { method: "POST" });
    expect(response.headers.get("content-type")).toBe("application/json");
    expect((await response.arrayBuffer()).byteLength).toBe(400);
    expect(session.failure).toBeNull();
  });

  concurrentTest("fails a body that streams past the cap", async () => {
    const session = mcpFetch(
      () => Promise.resolve(new Response(stream(20, 100))),
      { maxResponseBytes: 1_000 },
    ).session();

    const response = await session.fetch(`${ORIGIN}/mcp`, { method: "POST" });
    expect(await failureOf(response.arrayBuffer())).toBe("too_large");
    expect(session.failure).toBe("too_large");
    expect(session.signal.aborted).toBe(true);
  });

  concurrentTest("the cap covers every response in a session", async () => {
    const session = mcpFetch(
      () => Promise.resolve(new Response(stream(6, 100))),
      { maxResponseBytes: 1_000 },
    ).session();

    const first = await session.fetch(`${ORIGIN}/mcp`, { method: "POST" });
    expect((await first.arrayBuffer()).byteLength).toBe(600);
    const second = await session.fetch(`${ORIGIN}/mcp`, { method: "POST" });
    expect(await failureOf(second.arrayBuffer())).toBe("too_large");
  });

  concurrentTest(
    "fails at once when the declared length is over the cap",
    async () => {
      const session = mcpFetch(
        () =>
          Promise.resolve(
            new Response("x", { headers: { "content-length": "5000" } }),
          ),
        { maxResponseBytes: 1_000 },
      ).session();

      expect(
        await failureOf(session.fetch(`${ORIGIN}/mcp`, { method: "POST" })),
      ).toBe("too_large");
    },
  );

  concurrentTest("times out a server that never answers", async () => {
    const session = mcpFetch(() => new Promise<Response>(() => undefined), {
      timeoutMs: 50,
    }).session();

    expect(
      await failureOf(session.fetch(`${ORIGIN}/mcp`, { method: "POST" })),
    ).toBe("timeout");
    expect(session.failure).toBe("timeout");
  });

  concurrentTest("records a 401 without failing the request", async () => {
    const session = mcpFetch(() =>
      Promise.resolve(new Response("nope", { status: 401 })),
    ).session();

    const response = await session.fetch(`${ORIGIN}/mcp`, { method: "POST" });
    expect(response.status).toBe(401);
    expect(session.unauthorized).toBe(true);
    expect(session.failure).toBeNull();
  });
});
