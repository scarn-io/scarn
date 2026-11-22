import { describe, expect, test } from "bun:test";
import { mapGitHubIssueToWorkItem } from "@/integrations/github-ingest/application/map-github-issue-to-work-item";
import type { GitHubIssue } from "@/integrations/github-ingest/infra/github-issues-client";
import { parseUuidV7 } from "@/common/contracts/uuid-v7";

const projectId = parseUuidV7("0196917c-532c-75aa-b7d5-0a84b71a1f02");

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

describe("mapGitHubIssueToWorkItem", () => {
  test("maps a typical issue into upsert input", () => {
    const result = mapGitHubIssueToWorkItem({
      projectId,
      repoFullName: "acme/repo",
      issue: baseIssue,
    });

    expect(result.projectId).toBe(projectId);
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
    const result = mapGitHubIssueToWorkItem({
      projectId,
      repoFullName: "acme/repo",
      issue: { ...baseIssue, labels: [] },
    });
    expect(result.labels).toEqual([]);
  });

  test("maps issue state to work item state", () => {
    const open = mapGitHubIssueToWorkItem({
      projectId,
      repoFullName: "acme/repo",
      issue: baseIssue,
    });
    const closed = mapGitHubIssueToWorkItem({
      projectId,
      repoFullName: "acme/repo",
      issue: { ...baseIssue, state: "closed" },
    });

    expect(open.state).toBe("open");
    expect(closed.state).toBe("closed");
  });

  test("falls back to a placeholder when the body is empty", () => {
    const result = mapGitHubIssueToWorkItem({
      projectId,
      repoFullName: "acme/repo",
      issue: { ...baseIssue, body: "" },
    });
    expect(result.description).toContain("No description");
  });

  test("handles string-form labels", () => {
    const result = mapGitHubIssueToWorkItem({
      projectId,
      repoFullName: "acme/repo",
      issue: { ...baseIssue, labels: ["bug", { name: "ux" }] },
    });
    expect(result.labels).toEqual(["bug", "ux"]);
  });
});
