import { describe, expect, test } from "bun:test";
import { compileMcps, defineMcp, type McpCheckInput } from "../src";
import { resolveMcpChecks } from "../src/definitions/steps/define-mcp";
import { openCodeMcpServerConfigSchema } from "../src/opencode-mcp";

const NOTION_URL = "https://mcp.notion.com/mcp";
const auth = { connection: "notion" } as const;
const workerVar = {
  source: "inherit",
  name: "X",
  from: "X",
  secret: true,
  optional: false,
  applies: "agent",
} as const;

describe("defineMcp — connection auth", () => {
  test("a ref with auth, aliased under another key, compiles with auth kept", () => {
    const notion = defineMcp({ type: "ref", name: "notion", auth });
    const compiled = compileMcps({ docs: notion }, "step");
    expect(compiled.opencodeMcpJson).toEqual({
      docs: { type: "ref", name: "notion", auth },
    });
    expect(compiled.healthChecks).toEqual([]);
    expect(
      openCodeMcpServerConfigSchema.safeParse(compiled.opencodeMcpJson.docs)
        .success,
    ).toBe(true);
  });

  test("an inline remote with auth compiles with auth and no worker vars", () => {
    const notion = defineMcp({
      type: "remote",
      name: "notion",
      url: NOTION_URL,
      auth,
    });
    const compiled = compileMcps({ notion }, "step");
    expect(compiled.opencodeMcpJson).toEqual({
      notion: { type: "remote", url: NOTION_URL, auth },
    });
    expect(
      openCodeMcpServerConfigSchema.safeParse(compiled.opencodeMcpJson.notion)
        .success,
    ).toBe(true);
  });

  test("an inline remote with auth requires url", () => {
    expect(() =>
      defineMcp({ type: "remote", name: "notion", auth } as never),
    ).toThrow(/defineMcp "notion": url is required with auth/);
  });

  test("any valid connection name is accepted with any resource URL", () => {
    const docs = defineMcp({
      type: "remote",
      name: "docs",
      url: "https://docs.acme.test/mcp",
      auth: { connection: "acme-docs" },
    });
    expect(compileMcps({ docs }, "step").opencodeMcpJson).toEqual({
      docs: {
        type: "remote",
        url: "https://docs.acme.test/mcp",
        auth: { connection: "acme-docs" },
      },
    });
    expect(() =>
      defineMcp({
        type: "ref",
        name: "docs",
        auth: { connection: "a".repeat(63) },
      }),
    ).not.toThrow();
  });

  test("an invalid connection name is rejected", () => {
    for (const connection of [
      "Notion",
      "a_b",
      "",
      "-a",
      "a-",
      "a".repeat(64),
    ]) {
      expect(() =>
        defineMcp({ type: "ref", name: "docs", auth: { connection } }),
      ).toThrow(/defineMcp "docs": auth\.connection/);
      expect(() =>
        defineMcp({
          type: "remote",
          name: "docs",
          url: NOTION_URL,
          auth: { connection },
        }),
      ).toThrow(/defineMcp "docs": auth\.connection/);
    }
  });

  test("an inline remote with auth rejects a query string, fragment or credentials", () => {
    for (const url of [
      `${NOTION_URL}?workspace=1`,
      `${NOTION_URL}#x`,
      "https://user:pw@mcp.notion.com/mcp",
      "mcp.notion.com/mcp",
    ]) {
      expect(() =>
        defineMcp({ type: "remote", name: "notion", url, auth }),
      ).toThrow(
        /url: must be an absolute http\(s\) URL with no query string, fragment or credentials when auth is set; the notion connection/,
      );
    }
  });

  test("an inline remote with auth rejects headers", () => {
    expect(() =>
      defineMcp({
        type: "remote",
        name: "notion",
        url: NOTION_URL,
        auth,
        headers: { Authorization: "Bearer {env:NOTION_TOKEN}" },
      }),
    ).toThrow(/defineMcp "notion": headers: must be absent when auth is set/);
  });

  test("an inline remote with auth rejects oauth", () => {
    expect(() =>
      defineMcp({
        type: "remote",
        name: "notion",
        url: NOTION_URL,
        auth,
        oauth: false,
      }),
    ).toThrow(/defineMcp "notion": oauth: must be absent when auth is set/);
  });

  test("an inline remote with auth rejects workerVars", () => {
    expect(() =>
      defineMcp({
        type: "remote",
        name: "notion",
        url: NOTION_URL,
        auth,
        ...({
          workerVars: [workerVar],
        } as object),
      }),
    ).toThrow(
      /defineMcp "notion": workerVars: must be absent when auth is set/,
    );
  });

  test("a server with auth rejects env and optionalEnv", () => {
    expect(() =>
      defineMcp({
        type: "remote",
        name: "notion",
        url: NOTION_URL,
        auth,
        env: ["NOTION_TOKEN"],
      }),
    ).toThrow(/defineMcp "notion": env must be absent when auth is set/);
    expect(() =>
      defineMcp({
        type: "ref",
        name: "notion",
        auth,
        optionalEnv: ["NOTION_TOKEN"],
      }),
    ).toThrow(
      /defineMcp "notion": optionalEnv must be absent when auth is set/,
    );
  });

  test("a ref with auth rejects workerVars", () => {
    expect(() =>
      defineMcp({
        type: "ref",
        name: "notion",
        auth,
        workerVars: [workerVar],
      }),
    ).toThrow(
      /defineMcp "notion": workerVars: must be absent when auth is set/,
    );
  });

  for (const type of ["ref", "remote"] as const) {
    test(`a ${type} with auth supports checks and immutable check builders`, () => {
      const handle = defineMcp({
        ...(type === "remote"
          ? { type: "remote" as const, url: NOTION_URL }
          : { type: "ref" as const }),
        name: "notion",
        auth,
        healthChecks: { search: { tool: "notion_search" } },
      });
      const edited = handle
        .overrideCheck("search", { args: { query: "docs" }, severity: "warn" })
        .disableCheck("search")
        .enableCheck("search")
        .addCheck("read", { tool: "notion_fetch", enabled: false })
        .disableAllChecks()
        .enableCheck("search");

      expect(resolveMcpChecks(edited)).toEqual([
        {
          name: "search",
          check: {
            tool: "notion_search",
            args: { query: "docs" },
            severity: "warn",
          },
          enabled: true,
        },
        {
          name: "read",
          check: { tool: "notion_fetch", enabled: false },
          enabled: false,
        },
      ]);
      expect(resolveMcpChecks(handle)).toEqual([
        { name: "search", check: { tool: "notion_search" }, enabled: true },
      ]);
      expect(compileMcps({ docs: edited }, "step").healthChecks).toEqual([
        {
          kind: "tool",
          mcp: "docs",
          name: "docs.search",
          tool: "notion_search",
          args: { query: "docs" },
          severity: "warn",
          serialGroup: "docs",
        },
      ]);
    });
  }

  test("auth checks retain normal name, input and builder validation", () => {
    const invalidChecks: Record<string, McpCheckInput>[] = [
      { "bad.name": { tool: "notion_search" } },
      { search: { tool: "" } },
      { search: { tool: "notion_search", timeoutSeconds: 0 } },
    ];
    for (const healthChecks of invalidChecks) {
      expect(() =>
        defineMcp({
          type: "ref",
          name: "notion",
          auth,
          healthChecks,
        }),
      ).toThrow(/defineMcp "notion".*health check/);
    }
    const handle = defineMcp({
      type: "ref",
      name: "notion",
      auth,
      healthChecks: { search: { tool: "notion_search" } },
    });
    expect(() => handle.addCheck("search" as never, { tool: "read" })).toThrow(
      /already exists/,
    );
    expect(() => handle.addCheck("bad.name", { tool: "read" })).toThrow(
      /health check name/,
    );
    expect(() => handle.addCheck("read", { tool: "" })).toThrow(
      /health check "read"/,
    );
    expect(() => handle.overrideCheck("search", { timeoutSeconds: 0 })).toThrow(
      /overrideCheck/,
    );
    for (const method of [
      "overrideCheck",
      "enableCheck",
      "disableCheck",
    ] as const) {
      expect(() => handle[method]("missing" as never, {})).toThrow(
        /unknown health check "missing".*Known checks: search/,
      );
    }
  });

  test("auth rejects even empty env and optionalEnv beside valid checks", () => {
    for (const field of ["env", "optionalEnv"] as const) {
      expect(() =>
        defineMcp({
          type: "remote",
          name: "notion",
          url: NOTION_URL,
          auth,
          healthChecks: { search: { tool: "notion_search" } },
          [field]: [],
        }),
      ).toThrow(`${field} must be absent when auth is set`);
    }
  });

  test("a local server with auth is rejected", () => {
    expect(() =>
      defineMcp({
        type: "local",
        name: "notion",
        command: ["npx", "mcp-remote", NOTION_URL],
        ...({ auth } as object),
      }),
    ).toThrow(/defineMcp "notion"/);
    expect(
      openCodeMcpServerConfigSchema.safeParse({
        type: "local",
        command: ["npx"],
        auth,
      }).success,
    ).toBe(false);
  });
});

describe("openCodeMcpServerConfigSchema — connection auth", () => {
  test("rejects a remote with auth and an unusable URL, headers or oauth", () => {
    const issues = (entry: object): string[] => {
      const parsed = openCodeMcpServerConfigSchema.safeParse(entry);
      return parsed.success
        ? []
        : parsed.error.issues.map((issue) => issue.path.join("."));
    };
    expect(issues({ type: "remote", url: NOTION_URL, auth })).toEqual([]);
    expect(
      issues({ type: "remote", url: "https://mcp.notion.com/other", auth }),
    ).toEqual([]);
    expect(issues({ type: "remote", url: `${NOTION_URL}?x=1`, auth })).toEqual([
      "url",
    ]);
    expect(
      issues({ type: "remote", url: NOTION_URL, auth: { connection: "A" } }),
    ).toEqual(["auth.connection"]);
    expect(
      issues({
        type: "remote",
        url: NOTION_URL,
        auth,
        headers: { Authorization: "Bearer {env:T}" },
        oauth: false,
      }),
    ).toEqual(["headers", "oauth"]);
  });

  test("rejects a ref with auth and workerVars", () => {
    const entry = { type: "ref", workerVars: [workerVar] };
    expect(openCodeMcpServerConfigSchema.safeParse(entry).success).toBe(true);
    expect(
      openCodeMcpServerConfigSchema.safeParse({ ...entry, auth }).success,
    ).toBe(false);
  });
});
