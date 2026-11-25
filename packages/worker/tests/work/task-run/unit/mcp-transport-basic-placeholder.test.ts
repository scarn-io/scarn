/**
 * `{basic:USER_VAR:PASS_VAR}` substitution in the worker's MCP transport:
 * the encoded `Basic` credential, unset variables, and the values the log
 * masker gets.
 */
import { describe, expect, test } from "bun:test";
import {
  basicCredentialSecretValues,
  resolveRemoteMcpEndpoint,
  substituteEnv,
} from "../../../../src/common/infra/mcp-transport";

const base64 = (value: string) => Buffer.from(value, "utf8").toString("base64");

describe("{basic:…} substitution", () => {
  test("encodes base64(user:password), keeping ':' and non-ASCII in the password", () => {
    expect(
      substituteEnv("Basic {basic:EMAIL:TOKEN}", {
        EMAIL: "bot@example.com",
        TOKEN: "a:b:ü€",
      }),
    ).toBe(`Basic ${base64("bot@example.com:a:b:ü€")}`);
  });

  test("reads an unset variable as an empty string", () => {
    expect(substituteEnv("Basic {basic:EMAIL:TOKEN}", { EMAIL: "u" })).toBe(
      `Basic ${base64("u:")}`,
    );
  });

  test("substitutes {env:…} beside it", () => {
    expect(
      substituteEnv("{env:A} {basic:U:P}", { A: "x", U: "u", P: "p" }),
    ).toBe(`x ${base64("u:p")}`);
  });

  test("resolveRemoteMcpEndpoint encodes the header", () => {
    const endpoint = resolveRemoteMcpEndpoint(
      {
        type: "remote",
        url: "https://mcp.atlassian.com/v1/mcp",
        headers: { Authorization: "Basic {basic:EMAIL:TOKEN}" },
      },
      { EMAIL: "e", TOKEN: "t" },
    );
    expect(endpoint.headers).toEqual({
      Authorization: `Basic ${base64("e:t")}`,
    });
  });

  test("basicCredentialSecretValues returns each encoded credential of remote headers", () => {
    expect(
      basicCredentialSecretValues(
        {
          jira: {
            type: "remote",
            url: "https://mcp.atlassian.com/v1/mcp",
            headers: { Authorization: "Basic {basic:EMAIL:TOKEN}" },
          },
          db: { type: "local", command: ["pg-mcp"] },
        },
        { EMAIL: "e", TOKEN: "t" },
      ),
    ).toEqual([base64("e:t")]);
    expect(
      basicCredentialSecretValues(
        {
          jira: {
            type: "remote",
            url: "https://x.dev",
            headers: { Authorization: "Basic {basic:EMAIL:TOKEN}" },
          },
        },
        {},
      ),
    ).toEqual([]);
  });
});
