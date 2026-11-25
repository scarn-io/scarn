import { describe, expect, test } from "bun:test";
import { mapGitHubIssue, type GitHubIssue } from "@scarn/sdk/library/github";

const repo = "acme/repo";

const baseIssue: GitHubIssue = {
  id: 42,
  node_id: "I_kwDOABCD",
  number: 7,
  title: "Login fails on Safari",
  body: "Repro: open Safari → log in → boom.",
  html_url: "https://github.com/acme/repo/issues/7",
  state: "open",
  state_reason: null,
  user: { login: "alice" },
  labels: [{ name: "bug" }, { name: "ux" }],
  assignees: [{ login: "bob" }],
  comments: 3,
  created_at: "2026-04-22T11:00:00Z",
  updated_at: "2026-04-22T12:00:00Z",
  closed_at: null,
};

/** A `list_issues` item from GitHub's MCP server. */
const listIssuesItem: GitHubIssue = {
  number: 7,
  title: "Login fails on Safari",
  body: "Repro",
  state: "CLOSED",
  user: { login: "alice" },
  labels: ["bug"],
  assignees: ["bob"],
  comments: 1,
  created_at: "2026-04-22T11:00:00Z",
  updated_at: "2026-04-22T12:00:00Z",
};

describe("mapGitHubIssue", () => {
  test("maps a typical issue into upsert input", () => {
    const result = mapGitHubIssue(baseIssue, { repo });

    expect(result.platform).toBe("github");
    expect(result.platformId).toBe("I_kwDOABCD");
    expect(result.platformKey).toBe("acme/repo#7");
    expect(result.url).toBe("https://github.com/acme/repo/issues/7");
    expect(result.title).toBe("Login fails on Safari");
    expect(result.description).toContain("Repro");
    expect(result.labels).toEqual(["bug", "ux"]);
    expect(result.fields).toMatchObject({
      repository: "acme/repo",
      number: 7,
      state: "open",
      author: "alice",
      assignees: ["bob"],
      commentsCount: 3,
    });
    expect(result.fields).not.toHaveProperty("labels");
  });

  test("an issue with no labels maps to an empty list, so sync clears them", () => {
    const result = mapGitHubIssue({ ...baseIssue, labels: [] }, { repo });
    expect(result.labels).toEqual([]);
  });

  test("maps issue state to work item state", () => {
    const open = mapGitHubIssue(baseIssue, { repo });
    const closed = mapGitHubIssue({ ...baseIssue, state: "closed" }, { repo });

    expect(open.state).toBe("open");
    expect(closed.state).toBe("closed");
  });

  test("falls back to a placeholder when the body is empty", () => {
    const result = mapGitHubIssue({ ...baseIssue, body: "" }, { repo });
    expect(result.description).toContain("No description");
  });

  test("handles string-form labels", () => {
    const result = mapGitHubIssue(
      { ...baseIssue, labels: ["bug", { name: "ux" }] },
      { repo },
    );
    expect(result.labels).toEqual(["bug", "ux"]);
  });

  test("maps a list_issues item: lower-cased state, derived url, no platformId", () => {
    const result = mapGitHubIssue(listIssuesItem, { repo });

    expect(result).not.toHaveProperty("platformId");
    expect(result).toMatchObject({
      platformKey: "acme/repo#7",
      url: "https://github.com/acme/repo/issues/7",
      state: "closed",
      labels: ["bug"],
      fields: {
        state: "closed",
        stateReason: null,
        assignees: ["bob"],
        commentsCount: 1,
        closedAt: null,
      },
    });
  });
});
