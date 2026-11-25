import { describe, expect, test } from "bun:test";
import { Env, toStepSpec } from "../src/definitions/steps";
import { githubIssueImport, type GitHubAuth } from "../src/library/github";

const GITHUB_URL = "https://api.githubcopilot.com/mcp/x/issues/readonly";

const stepWith = (auth: GitHubAuth) =>
  toStepSpec(
    githubIssueImport({
      key: "import-github",
      repos: ["acme/repo"],
      auth,
    }),
  );

const envJsonOf = (spec: ReturnType<typeof stepWith>) =>
  (spec.environment as { envJson?: unknown }).envJson ?? null;

describe("githubIssueImport auth", () => {
  test("a worker variable is read by the Bearer header, MCP-only", () => {
    const spec = stepWith({
      type: "apiKey",
      token: Env.inherit({ secret: true, from: "ACME_GITHUB_TOKEN" }),
    });
    expect(spec.opencodeMcpJson?.["github"]).toMatchObject({
      type: "remote",
      url: GITHUB_URL,
      headers: { Authorization: "Bearer {env:ACME_GITHUB_TOKEN}" },
      workerVars: [
        expect.objectContaining({ name: "ACME_GITHUB_TOKEN", secret: true }),
      ],
    });
    expect(envJsonOf(spec)).toBeNull();
  });

  test("a project secret is declared as an MCP-only server variable", () => {
    const spec = stepWith({
      type: "apiKey",
      token: Env.secret("ACME_GITHUB_PAT"),
    });
    expect(spec.opencodeMcpJson?.["github"]).toEqual({
      type: "remote",
      url: GITHUB_URL,
      headers: { Authorization: "Bearer {env:GITHUB_TOKEN}" },
      workerVars: [
        {
          name: "GITHUB_TOKEN",
          source: "secret",
          secretName: "ACME_GITHUB_PAT",
          applies: "agent",
        },
      ],
    });
    expect(envJsonOf(spec)).toBeNull();
  });

  test("a literal token throws", () => {
    expect(() =>
      stepWith({
        type: "apiKey",
        token: "ghp_secret",
      } as unknown as GitHubAuth),
    ).toThrow(
      /githubIssueImport "import-github": auth\.token: token must be Env\.secret/,
    );
  });

  test("a token from a non-secret worker variable throws", () => {
    expect(() =>
      stepWith({
        type: "apiKey",
        token: Env.inherit({ from: "GITHUB_TOKEN" }),
      } as unknown as GitHubAuth),
    ).toThrow(/auth\.token: token must be/);
  });

  test("auth is required", () => {
    expect(() =>
      githubIssueImport({
        key: "import-github",
        repos: ["acme/repo"],
      } as unknown as Parameters<typeof githubIssueImport>[0]),
    ).toThrow(/githubIssueImport "import-github": auth/);
  });

  test("oauth is not supported", () => {
    expect(() => stepWith({ type: "oauth" } as unknown as GitHubAuth)).toThrow(
      /OAuth is not supported/,
    );
  });
});
