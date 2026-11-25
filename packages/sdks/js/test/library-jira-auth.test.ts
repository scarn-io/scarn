import { describe, expect, test } from "bun:test";
import { Env, toStepSpec } from "../src/definitions/steps";
import { jiraIssueImport, type JiraAuth } from "../src/library/jira";

const ATLASSIAN_URL = "https://mcp.atlassian.com/v2/mcp";

const stepWith = (auth?: JiraAuth) =>
  toStepSpec(
    jiraIssueImport({
      key: "import-jira",
      site: "https://acme.atlassian.net",
      projectKeys: ["ABC"],
      ...(auth ? { auth } : {}),
    }),
  );

describe("jiraIssueImport auth", () => {
  test("defaults to the atlassian managed connection", () => {
    const spec = stepWith();
    expect(spec.opencodeMcpJson).toEqual({
      atlassian: {
        type: "remote",
        url: ATLASSIAN_URL,
        auth: { connection: "atlassian" },
      },
    });
    expect(spec.environment).toMatchObject({ kind: "inline" });
    expect(
      (spec.environment as { envJson?: unknown }).envJson ?? null,
    ).toBeNull();
  });

  test("oauth names another connection", () => {
    expect(
      stepWith({ type: "oauth", connection: "atlassian-eu" }).opencodeMcpJson,
    ).toEqual({
      atlassian: {
        type: "remote",
        url: ATLASSIAN_URL,
        auth: { connection: "atlassian-eu" },
      },
    });
  });

  test("apiKey with worker variables reads them in the basic header, MCP-only", () => {
    const spec = stepWith({
      type: "apiKey",
      email: Env.inherit({ from: "ACME_JIRA_EMAIL" }),
      token: Env.inherit({ secret: true, from: "ACME_JIRA_TOKEN" }),
    });
    expect(spec.opencodeMcpJson?.["atlassian"]).toMatchObject({
      type: "remote",
      url: ATLASSIAN_URL,
      headers: {
        Authorization: "Basic {basic:ACME_JIRA_EMAIL:ACME_JIRA_TOKEN}",
      },
      workerVars: [
        expect.objectContaining({ name: "ACME_JIRA_EMAIL", secret: true }),
        expect.objectContaining({ name: "ACME_JIRA_TOKEN", secret: true }),
      ],
    });
    expect(
      (spec.environment as { envJson?: unknown }).envJson ?? null,
    ).toBeNull();
  });

  test("apiKey with a project secret and a literal email declares both as MCP-only server variables", () => {
    const spec = stepWith({
      type: "apiKey",
      email: "bot@acme.com",
      token: Env.secret("JIRA_API_TOKEN"),
    });
    expect(spec.opencodeMcpJson?.["atlassian"]).toEqual({
      type: "remote",
      url: ATLASSIAN_URL,
      headers: { Authorization: "Basic {basic:JIRA_EMAIL:JIRA_API_TOKEN}" },
      workerVars: [
        {
          name: "JIRA_EMAIL",
          source: "value",
          value: "bot@acme.com",
          secret: false,
          applies: "agent",
        },
        {
          name: "JIRA_API_TOKEN",
          source: "secret",
          secretName: "JIRA_API_TOKEN",
          applies: "agent",
        },
      ],
    });
    expect(
      (spec.environment as { envJson?: unknown }).envJson ?? null,
    ).toBeNull();
  });

  test("a literal token throws", () => {
    expect(() =>
      stepWith({
        type: "apiKey",
        email: "bot@acme.com",
        token: "secret-token",
      } as unknown as JiraAuth),
    ).toThrow(
      /jiraIssueImport "import-jira": auth\.token: token must be Env\.secret/,
    );
  });

  test("a token from a non-secret worker variable throws", () => {
    expect(() =>
      stepWith({
        type: "apiKey",
        email: "bot@acme.com",
        token: Env.inherit({ from: "JIRA_TOKEN" }),
      } as unknown as JiraAuth),
    ).toThrow(/auth\.token: token must be/);
  });

  test("an invalid connection name throws", () => {
    expect(() => stepWith({ type: "oauth", connection: "Atlassian" })).toThrow(
      /auth\.connection/,
    );
  });

  test("email and token on the same variable throw", () => {
    expect(() =>
      stepWith({
        type: "apiKey",
        email: Env.inherit({ from: "JIRA" }),
        token: Env.inherit({ secret: true, from: "JIRA" }),
      }),
    ).toThrow(/both read the variable JIRA/);
  });
});
