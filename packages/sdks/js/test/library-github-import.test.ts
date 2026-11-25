import { describe, expect, test } from "bun:test";
import { defineAutomation } from "../src/automations";
import {
  createFakeMcpClients,
  createFakeWorkItems,
  Env,
  McpToolError,
  toStepSpec,
  WorkItemsRefusedError,
} from "../src/definitions/steps";
import { findCodeStepInModule } from "../src/push/code-step-lookup";
import { githubIssueImport, type GitHubIssue } from "../src/library/github";
import { githubImportFn } from "../src/library/github/github-issue-import";
import { githubServerFor } from "../src/library/github/mcp-adapter";
import {
  GITHUB_CURSOR_OVERLAP_MS,
  runGitHubIssueImport,
  type GitHubImportOptions,
} from "../src/library/github/import-loop";
import type {
  GitHubListPage,
  GitHubSourceClient,
} from "../src/library/github/source-client";

async function rejection(promise: Promise<object>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error("expected the promise to reject");
}

const now = new Date("2026-11-24T12:00:00.000Z");
const auth = { type: "apiKey", token: Env.secret("GITHUB_TOKEN") } as const;

const importGitHub = githubIssueImport({
  key: "import-github",
  repos: ["acme/web", "acme/api"],
  auth,
});
const features = importGitHub.grants?.map((grant) => ({ _grant: grant })) ?? [];

function issue(
  number: number,
  updated: string,
  labels: string[] = [],
): GitHubIssue {
  return {
    number,
    title: `Issue ${String(number)}`,
    body: "Body",
    state: "OPEN",
    user: { login: "alice" },
    labels,
    assignees: [],
    comments: 0,
    created_at: updated,
    updated_at: updated,
  };
}

type Request = Parameters<GitHubSourceClient["listIssuesUpdatedSince"]>[0];

/** A source that serves `pages[repo]` one after another. */
function fakeSource(pages: Record<string, GitHubListPage[]>) {
  const requests: Request[] = [];
  const source: GitHubSourceClient = {
    listIssuesUpdatedSince: (request) => {
      requests.push(request);
      const served = requests.filter((r) => r.repo === request.repo).length;
      const page = pages[request.repo]?.[served - 1];
      return Promise.resolve(page ?? { issues: [], next: null });
    },
  };
  return { source, requests };
}

function options(
  source: GitHubSourceClient,
  workItems: GitHubImportOptions["workItems"],
): GitHubImportOptions {
  return {
    source,
    workItems,
    repos: ["acme/web", "acme/api"],
    labels: ["github"],
    firstSyncHorizonDays: 30,
    now: () => now,
  };
}

const fakeWorkItems = (seed: Parameters<typeof createFakeWorkItems>[1] = {}) =>
  createFakeWorkItems(features as never, seed) as unknown as ReturnType<
    typeof createFakeWorkItems
  > &
    GitHubImportOptions["workItems"];

describe("runGitHubIssueImport", () => {
  test("first run reaches back the horizon and upserts each page in order", async () => {
    const { source, requests } = fakeSource({
      "acme/web": [
        { issues: [issue(1, "2026-11-20T10:00:00Z")], next: "p2" },
        { issues: [issue(2, "2026-11-21T10:00:00Z", ["bug"])], next: null },
      ],
    });
    const workItems = fakeWorkItems();
    const result = await runGitHubIssueImport(options(source, workItems));

    expect(requests).toEqual([
      { repo: "acme/web", since: "2026-10-25T12:00:00.000Z", cursor: null },
      { repo: "acme/web", since: "2026-10-25T12:00:00.000Z", cursor: "p2" },
      { repo: "acme/api", since: "2026-10-25T12:00:00.000Z", cursor: null },
    ]);
    expect(result).toEqual({
      upserted: 2,
      repos: [
        { repo: "acme/web", seen: 2, upserted: 2 },
        { repo: "acme/api", seen: 0, upserted: 0 },
      ],
    });
    expect(workItems.items().map((item) => item.platformKey)).toEqual([
      "acme/web#1",
      "acme/web#2",
    ]);
    expect(workItems.items()[1]).toMatchObject({
      platform: "github",
      labels: ["github"],
      url: "https://github.com/acme/web/issues/2",
      fields: { githubLabels: ["bug"], state: "open" },
    });
    expect(workItems.items()[1]).not.toHaveProperty("platformId");
  });

  test("a later run resumes from each repo's newest item minus the overlap", async () => {
    const workItems = fakeWorkItems({
      items: [
        {
          platform: "github",
          platformKey: "acme/web#1",
          title: "Old",
          description: "Old",
          sourceUpdatedAt: "2026-11-24T11:00:00.000Z",
        },
        {
          platform: "github",
          platformKey: "acme/api#9",
          title: "Old",
          description: "Old",
          sourceUpdatedAt: "2026-11-23T08:00:00.000Z",
        },
      ],
    });
    const { source, requests } = fakeSource({
      "acme/web": [
        {
          issues: [
            issue(1, "2026-11-24T11:00:00.000Z"),
            issue(2, "2026-11-24T11:30:00.000Z"),
          ],
          next: null,
        },
      ],
    });
    const result = await runGitHubIssueImport(options(source, workItems));
    expect(requests.map((r) => r.since)).toEqual([
      new Date(
        Date.parse("2026-11-24T11:00:00.000Z") - GITHUB_CURSOR_OVERLAP_MS,
      ).toISOString(),
      new Date(
        Date.parse("2026-11-23T08:00:00.000Z") - GITHUB_CURSOR_OVERLAP_MS,
      ).toISOString(),
    ]);
    // The overlap re-reads #1, which isn't newer, so only #2 counts.
    expect(result.repos[0]).toEqual({
      repo: "acme/web",
      seen: 2,
      upserted: 1,
    });
  });

  test("a pull request is skipped", async () => {
    const { source } = fakeSource({
      "acme/web": [
        {
          issues: [
            { ...issue(1, "2026-11-24T11:00:00Z"), pull_request: {} },
            issue(2, "2026-11-24T11:10:00Z"),
          ],
          next: null,
        },
      ],
    });
    const workItems = fakeWorkItems();
    const result = await runGitHubIssueImport(options(source, workItems));
    expect(result.repos[0]).toEqual({ repo: "acme/web", seen: 2, upserted: 1 });
    expect(workItems.items().map((item) => item.platformKey)).toEqual([
      "acme/web#2",
    ]);
  });

  test("a failing page keeps earlier pages and stops", async () => {
    let calls = 0;
    const source: GitHubSourceClient = {
      listIssuesUpdatedSince: () => {
        calls += 1;
        if (calls === 1) {
          return Promise.resolve({
            issues: [issue(1, "2026-11-20T10:00:00Z")],
            next: "p2",
          });
        }
        return Promise.reject(new McpToolError("API rate limit exceeded", []));
      },
    };
    const workItems = fakeWorkItems();
    expect(
      await rejection(runGitHubIssueImport(options(source, workItems))),
    ).toBeInstanceOf(McpToolError);
    expect(workItems.items().map((item) => item.platformKey)).toEqual([
      "acme/web#1",
    ]);
  });

  test("a refused upsert fails the run", async () => {
    const { source } = fakeSource({
      "acme/web": [{ issues: [issue(1, "2026-11-20T10:00:00Z")], next: null }],
    });
    const workItems = fakeWorkItems();
    expect(
      await rejection(
        runGitHubIssueImport({
          ...options(source, workItems),
          labels: ["other"],
        }),
      ),
    ).toBeInstanceOf(WorkItemsRefusedError);
    expect(workItems.items()).toEqual([]);
  });

  test("an issue with an invalid updated time fails", async () => {
    const { source } = fakeSource({
      "acme/web": [{ issues: [issue(1, "not a date")], next: null }],
    });
    expect(
      (await rejection(runGitHubIssueImport(options(source, fakeWorkItems()))))
        .message,
    ).toMatch(/acme\/web#1 has no valid updated time/);
  });
});

describe("githubIssueImport", () => {
  test("keeps only failed and manual runs' logs unless told otherwise", () => {
    expect(importGitHub.logs).toEqual({ archive: "on-failure" });
    expect(
      "logs" in
        githubIssueImport({
          key: "import-github",
          repos: ["acme/web"],
          auth,
          logs: { archive: "always" },
        }),
    ).toBe(false);
  });

  test("grants read, and create and update per repo, under its label", () => {
    expect(toStepSpec(importGitHub)).toMatchObject({
      key: "import-github",
      kind: "code",
      name: "Import GitHub issues (acme/web, acme/api)",
      grants: [
        { action: "read", scope: "project" },
        {
          action: "create",
          scope: "project",
          keyPrefix: "acme/web#",
          labels: ["github"],
        },
        {
          action: "update",
          scope: "project",
          keyPrefix: "acme/web#",
          labels: ["github"],
        },
        {
          action: "create",
          scope: "project",
          keyPrefix: "acme/api#",
          labels: ["github"],
        },
        {
          action: "update",
          scope: "project",
          keyPrefix: "acme/api#",
          labels: ["github"],
        },
      ],
    });
  });

  test("the user's module is where the worker finds its fn", () => {
    expect(findCodeStepInModule({ importGitHub }, "import-github")).toBe(
      importGitHub.entrypoint?.fn,
    );
  });

  test("its fn runs the import over context.mcp and context.workItems", async () => {
    const mcp = createFakeMcpClients(
      { github: githubServerFor(auth).handle },
      {
        github: {
          listIssues: () => ({
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  issues: [issue(7, "2026-11-24T11:00:00Z")],
                  totalCount: 1,
                  pageInfo: { hasNextPage: false, hasPreviousPage: false },
                }),
              },
            ],
            structuredContent: null,
          }),
        },
      },
    );
    const workItems = fakeWorkItems();
    const fn = githubImportFn({
      repos: ["acme/web"],
      labels: ["github"],
      now: () => now,
    });
    expect(await fn({}, { mcp, workItems })).toEqual({
      upserted: 1,
      repos: [{ repo: "acme/web", seen: 1, upserted: 1 }],
    });
    expect(workItems.items()[0]).toMatchObject({
      platformKey: "acme/web#7",
      sourceUpdatedAt: "2026-11-24T11:00:00Z",
    });
  });

  test.each([
    [{ repos: ["acme"] }, /repo "acme" must be "owner\/repo"/],
    [{ repos: ["acme/web/extra"] }, /must be "owner\/repo"/],
    [{ repos: ["acme/web", "Acme/Web"] }, /more than once/],
    [{ firstSyncHorizonDays: 0 }, /firstSyncHorizonDays/],
  ])("rejects %p", (patch, message) => {
    expect(() =>
      githubIssueImport({
        key: "import-github",
        repos: ["acme/web"],
        auth,
        ...(patch as object),
      }),
    ).toThrow(message);
  });

  test("schedule returns a rule that starts the step every 5 minutes by default", () => {
    const automation = defineAutomation({
      key: "github-intake",
      title: "GitHub intake",
      scope: "project",
      rules: [githubIssueImport.schedule(importGitHub)],
    });
    expect(JSON.stringify(automation)).toContain("*/5 * * * *");
    expect(JSON.stringify(automation)).toContain("import-github");
  });

  test("schedule takes a cron, timezone and key", () => {
    const rule = githubIssueImport.schedule(importGitHub, {
      cron: "0 * * * *",
      timezone: "Europe/London",
      key: "hourly",
    });
    expect(rule.key).toBe("hourly");
  });
});
