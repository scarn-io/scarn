import { describe, expect, test } from "bun:test";
import { compileMcps, defineMcp, defineStep } from "../src";
import { codeStep, toStepSpec } from "../src/definitions/steps";
import {
  collectEnvPlaceholderNames,
  isEnvPlaceholderValue,
  openCodeMcpServersSchema,
} from "../src/opencode-mcp";

const jira = () =>
  defineMcp({
    type: "remote",
    name: "jira",
    url: "https://mcp.atlassian.com/v1/mcp",
    headers: { Authorization: "Basic {basic:JIRA_EMAIL:JIRA_API_TOKEN}" },
  });

describe("{basic:USER_VAR:PASS_VAR}", () => {
  test("is a placeholder-only value, alone or behind an auth scheme", () => {
    expect(isEnvPlaceholderValue("Basic {basic:EMAIL:TOKEN}")).toBe(true);
    expect(isEnvPlaceholderValue("{basic:EMAIL:TOKEN}")).toBe(true);
    expect(isEnvPlaceholderValue("Basic {basic:EMAIL:TOKEN}x")).toBe(false);
    expect(isEnvPlaceholderValue("Basic {basic:EMAIL}")).toBe(false);
    expect(isEnvPlaceholderValue("Basic {basic:EMAIL:1TOKEN}")).toBe(false);
    expect(isEnvPlaceholderValue("Basic dXNlcjpwYXNz")).toBe(false);
  });

  test("both names are collected as variables", () => {
    expect(
      collectEnvPlaceholderNames({
        headers: {
          Authorization: "Basic {basic:JIRA_EMAIL:JIRA_API_TOKEN}",
          X: "{env:TRACE}",
        },
      }),
    ).toEqual(["JIRA_API_TOKEN", "JIRA_EMAIL", "TRACE"]);
  });

  test("defineMcp accepts it in remote headers and infers both names as required secret vars", () => {
    const compiled = compileMcps({ jira: jira() }, "poll");
    expect(compiled.opencodeMcpJson["jira"]).toMatchObject({
      workerVars: [
        expect.objectContaining({ name: "JIRA_API_TOKEN", secret: true }),
        expect.objectContaining({ name: "JIRA_EMAIL", secret: true }),
      ],
    });
  });

  test("defineMcp rejects a literal header, naming both forms", () => {
    expect(() =>
      defineMcp({
        type: "remote",
        name: "jira",
        url: "https://x.test",
        headers: { Authorization: "Basic dXNlcjpwYXNz" },
      }),
    ).toThrow(/\{env:VAR\} or \{basic:USER_VAR:PASS_VAR\}/);
  });

  test("defineMcp rejects it outside a remote server's headers", () => {
    expect(() =>
      defineMcp({
        type: "local",
        name: "svc",
        command: ["svc"],
        environment: { AUTH: "{basic:U:P}" },
      }),
    ).toThrow(/environment: may not use \{basic:USER_VAR:PASS_VAR\}/);
    expect(() =>
      defineMcp({
        type: "remote",
        name: "svc",
        url: "https://{basic:U:P}.test",
      }),
    ).toThrow(/url: may not use \{basic:USER_VAR:PASS_VAR\}/);
  });

  test("the stored schema rejects it outside a remote server's headers", () => {
    expect(
      openCodeMcpServersSchema.safeParse({
        a: { type: "local", command: ["x"], environment: { A: "{basic:U:P}" } },
      }).success,
    ).toBe(false);
    expect(
      openCodeMcpServersSchema.safeParse({
        a: {
          type: "remote",
          url: "https://x.test",
          headers: { Authorization: "Basic {basic:U:P}" },
        },
      }).success,
    ).toBe(true);
  });

  test("an agent step can't use a server with it", () => {
    expect(() =>
      defineStep({
        key: "triage",
        name: "Triage",
        agentPrompt: "Go.",
        mcps: { jira: jira() },
      }),
    ).toThrow(/Step "triage" mcps\.jira: headers use \{basic:/);
  });

  test("a code step can", () => {
    const spec = toStepSpec(
      codeStep({
        key: "poll",
        name: "Poll",
        mcps: { jira: jira() },
        fn: () => ({}),
      }),
    );
    expect(spec.opencodeMcpJson?.["jira"]).toMatchObject({
      type: "remote",
      headers: { Authorization: "Basic {basic:JIRA_EMAIL:JIRA_API_TOKEN}" },
    });
  });
});
