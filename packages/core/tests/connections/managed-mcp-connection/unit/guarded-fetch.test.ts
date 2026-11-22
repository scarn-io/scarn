import { describe, expect } from "bun:test";
import {
  GuardedFetch,
  isBlockedAddress,
  OutboundRequestError,
  type GuardedFetchOptions,
} from "@/connections/managed-mcp-connection/infra/guarded-fetch";
import { concurrentTest } from "tests/utils";

const ORIGIN = "https://mcp.notion.com";
const PUBLIC_IP = "104.18.10.10";

const guarded = (
  fetchImpl: (input: URL, init?: RequestInit) => Promise<Response>,
  options: Partial<GuardedFetchOptions> = {},
) =>
  new GuardedFetch({
    allowedOrigins: [ORIGIN],
    resolveHost: () => Promise.resolve([PUBLIC_IP]),
    fetchImpl: fetchImpl as typeof fetch,
    ...options,
  });

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

describe("GuardedFetch", () => {
  concurrentTest("only reaches the allowed HTTPS origin", async () => {
    let called = 0;
    const client = guarded(() => {
      called += 1;
      return Promise.resolve(new Response("{}"));
    });

    for (const url of [
      "https://evil.example/token",
      "http://mcp.notion.com/token",
      "https://mcp.notion.com.evil.example/token",
      "https://user:pass@mcp.notion.com/token",
      "not a url",
    ]) {
      expect(await failureOf(client.request(url, { method: "GET" }))).toBe(
        "blocked",
      );
    }
    expect(called).toBe(0);

    const response = await client.request(`${ORIGIN}/token`, { method: "GET" });
    expect(response.status).toBe(200);
    expect(called).toBe(1);
  });

  concurrentTest(
    "asks fetch not to follow redirects and rejects them",
    async () => {
      let redirectMode: RequestRedirect | undefined;
      const client = guarded((_url, init) => {
        redirectMode = init?.redirect;
        return Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { location: "http://169.254.169.254/" },
          }),
        );
      });

      expect(
        await failureOf(client.request(`${ORIGIN}/token`, { method: "POST" })),
      ).toBe("redirect");
      expect(redirectMode).toBe("manual");
    },
  );

  concurrentTest(
    "rejects a host whose DNS answer includes a private address",
    async () => {
      let called = 0;
      for (const addresses of [
        ["10.0.0.5"],
        [PUBLIC_IP, "192.168.1.1"],
        ["169.254.169.254"],
        ["::1"],
        ["fd00:ec2::254"],
        ["::ffff:127.0.0.1"],
        [],
      ]) {
        const client = guarded(
          () => {
            called += 1;
            return Promise.resolve(new Response("{}"));
          },
          { resolveHost: () => Promise.resolve(addresses) },
        );
        expect(
          await failureOf(client.request(`${ORIGIN}/token`, { method: "GET" })),
        ).toBe("blocked");
      }
      expect(called).toBe(0);
    },
  );

  concurrentTest(
    "tells a failure before sending apart from one after",
    async () => {
      const failing = (error: Error) => guarded(() => Promise.reject(error));
      const withCode = (code: string) =>
        Object.assign(new TypeError("fetch failed"), { code });

      expect(
        await failureOf(
          guarded(() => Promise.resolve(new Response("{}")), {
            resolveHost: () => Promise.reject(new Error("ENOTFOUND")),
          }).request(`${ORIGIN}/token`, { method: "POST" }),
        ),
      ).toBe("unreachable");
      expect(
        await failureOf(
          failing(withCode("ECONNREFUSED")).request(`${ORIGIN}/token`, {
            method: "POST",
          }),
        ),
      ).toBe("unreachable");
      expect(
        await failureOf(
          failing(withCode("ECONNRESET")).request(`${ORIGIN}/token`, {
            method: "POST",
          }),
        ),
      ).toBe("network");
      expect(
        await failureOf(
          failing(new Error("boom")).request(`${ORIGIN}/token`, {
            method: "POST",
          }),
        ),
      ).toBe("network");
    },
  );

  concurrentTest("caps the response size", async () => {
    const client = guarded(
      () => Promise.resolve(new Response("x".repeat(2048))),
      { maxResponseBytes: 1024 },
    );
    const response = await client.request(`${ORIGIN}/token`, { method: "GET" });

    expect(await failureOf(response.text())).toBe("too_large");
  });

  concurrentTest("times out a slow response", async () => {
    const client = guarded(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(init.signal?.reason as Error);
          });
        }),
      { timeoutMs: 50 },
    );

    expect(
      await failureOf(client.request(`${ORIGIN}/token`, { method: "POST" })),
    ).toBe("timeout");
  });

  concurrentTest(
    "lets only an explicit loopback allowance use HTTP and loopback",
    async () => {
      expect(
        () =>
          new GuardedFetch({
            allowedOrigins: [ORIGIN],
            loopbackOrigins: ["http://evil.example"],
          }),
      ).toThrow();

      const client = guarded(() => Promise.resolve(new Response("{}")), {
        loopbackOrigins: ["http://127.0.0.1:4555"],
        resolveHost: () => Promise.resolve(["127.0.0.1"]),
      });
      const response = await client.request("http://127.0.0.1:4555/token", {
        method: "GET",
      });
      expect(response.status).toBe(200);
      expect(
        await failureOf(
          client.request("http://127.0.0.1:4556/token", { method: "GET" }),
        ),
      ).toBe("blocked");
    },
  );
});

describe("isBlockedAddress", () => {
  concurrentTest("blocks non-public addresses only", () => {
    for (const address of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "192.168.0.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "::",
      "::1",
      "fe80::1",
      "fc00::1",
      "::ffff:10.0.0.1",
      "mcp.notion.com",
    ]) {
      expect(isBlockedAddress(address)).toBe(true);
    }
    for (const address of [PUBLIC_IP, "8.8.8.8", "2606:4700::6810:1"]) {
      expect(isBlockedAddress(address)).toBe(false);
    }
  });
});
