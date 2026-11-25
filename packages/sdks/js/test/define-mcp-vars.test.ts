import { describe, expect, test } from "bun:test";
import { compileMcps, defineMcp, Env } from "../src";

const remote = {
  type: "remote" as const,
  name: "api",
  url: "https://mcp.example.com/mcp",
  headers: { Authorization: "Basic {basic:API_USER:API_TOKEN}" },
};

describe("defineMcp vars", () => {
  test("compile to the server's workerVars, ahead of inferred ones", () => {
    const handle = defineMcp({
      ...remote,
      vars: {
        API_USER: "bot@acme.com",
        API_TOKEN: Env.secret("PROJECT_TOKEN"),
      },
    });
    expect(compileMcps({ api: handle }, "step").opencodeMcpJson).toEqual({
      api: {
        type: "remote",
        url: remote.url,
        headers: remote.headers,
        workerVars: [
          {
            name: "API_USER",
            source: "value",
            value: "bot@acme.com",
            secret: false,
            applies: "agent",
          },
          {
            name: "API_TOKEN",
            source: "secret",
            secretName: "PROJECT_TOKEN",
            applies: "agent",
          },
        ],
      },
    });
  });

  test("an Env.inherit var is tagged with the server key", () => {
    const handle = defineMcp({
      ...remote,
      vars: { API_TOKEN: Env.inherit({ secret: true, from: "HOST_TOKEN" }) },
    });
    expect(
      compileMcps({ svc: handle }, "step").opencodeMcpJson.svc?.workerVars,
    ).toEqual([
      {
        name: "API_TOKEN",
        source: "inherit",
        from: "HOST_TOKEN",
        secret: true,
        optional: false,
        mcp: "svc",
        applies: "agent",
      },
      {
        name: "API_USER",
        source: "inherit",
        from: "API_USER",
        secret: true,
        optional: false,
        mcp: "svc",
        applies: "agent",
      },
    ]);
  });

  test("rejects a static literal on a secret-looking name", () => {
    expect(() =>
      defineMcp({ ...remote, vars: { API_TOKEN: "literal-token" } }),
    ).toThrow(/defineMcp "api": vars: Env "API_TOKEN"/);
  });

  test("rejects a var that applies to setup", () => {
    expect(() =>
      defineMcp({
        ...remote,
        vars: { API_TOKEN: Env.secret("T", { applies: "both" }) },
      }),
    ).toThrow(/vars\.API_TOKEN: applies must be "agent"/);
  });

  test("rejects a name also listed in env", () => {
    expect(() =>
      defineMcp({
        ...remote,
        env: ["API_TOKEN"],
        vars: { API_TOKEN: Env.secret("T") },
      }),
    ).toThrow(/env var "API_TOKEN" is declared more than once/);
  });

  test("rejects vars beside auth", () => {
    expect(() =>
      defineMcp({
        type: "remote",
        name: "api",
        url: remote.url,
        auth: { connection: "atlassian" },
        vars: { API_TOKEN: Env.secret("T") },
      }),
    ).toThrow(/vars must be absent when auth is set/);
  });
});
