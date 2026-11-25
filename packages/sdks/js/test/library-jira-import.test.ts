import { describe, expect, test } from "bun:test";
import { defineAutomation } from "../src/automations";
import {
  createFakeMcpClients,
  createFakeWorkItems,
  McpToolError,
  toStepSpec,
  WorkItemsRefusedError,
} from "../src/definitions/steps";
import { findCodeStepInModule } from "../src/push/code-step-lookup";
import { jiraIssueImport, type JiraIssue } from "../src/library/jira";
import { jiraImportFn } from "../src/library/jira/jira-issue-import";
import { atlassianServerFor } from "../src/library/jira/mcp-adapter";
import {
  JIRA_CURSOR_OVERLAP_MS,
  runJiraIssueImport,
  type JiraImportOptions,
} from "../src/library/jira/import-loop";
import type {
  JiraSearchPage,
  JiraSourceClient,
} from "../src/library/jira/source-client";

const site = "https://acme.atlassian.net";

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

const importJira = jiraIssueImport({
  key: "import-jira",
  site,
  projectKeys: ["ABC", "XYZ"],
});
const features = importJira.grants?.map((grant) => ({ _grant: grant })) ?? [];

function issue(key: string, updated: string, labels: string[] = []): JiraIssue {
  return {
    id: key,
    key,
    fields: {
      summary: `Summary of ${key}`,
      updated,
      created: updated,
      status: { name: "To Do", statusCategory: { key: "new" } },
      labels,
    },
  };
}

type Request = Parameters<JiraSourceClient["searchIssuesUpdatedSince"]>[0];

/** A source that serves `pages[projectKey]` one after another. */
function fakeSource(pages: Record<string, JiraSearchPage[]>) {
  const requests: Request[] = [];
  const source: JiraSourceClient = {
    searchIssuesUpdatedSince: (request) => {
      requests.push(request);
      const served = requests.filter(
        (r) => r.projectKey === request.projectKey,
      ).length;
      const page = pages[request.projectKey]?.[served - 1];
      return Promise.resolve(page ?? { issues: [], next: null });
    },
  };
  return { source, requests };
}

function options(
  source: JiraSourceClient,
  workItems: JiraImportOptions["workItems"],
): JiraImportOptions {
  return {
    source,
    workItems,
    site,
    projectKeys: ["ABC", "XYZ"],
    labels: ["jira"],
    firstSyncHorizonDays: 30,
    now: () => now,
  };
}

const fakeWorkItems = (seed: Parameters<typeof createFakeWorkItems>[1] = {}) =>
  createFakeWorkItems(features as never, seed) as unknown as ReturnType<
    typeof createFakeWorkItems
  > &
    JiraImportOptions["workItems"];

describe("runJiraIssueImport", () => {
  test("first run reaches back the horizon and upserts each page in order", async () => {
    const { source, requests } = fakeSource({
      ABC: [
        { issues: [issue("ABC-1", "2026-11-20T10:00:00.000Z")], next: "p2" },
        {
          issues: [issue("ABC-2", "2026-11-21T10:00:00.000Z", ["bug"])],
          next: null,
        },
      ],
    });
    const workItems = fakeWorkItems();
    const result = await runJiraIssueImport(options(source, workItems));

    expect(requests).toEqual([
      { projectKey: "ABC", since: "2026-10-25T12:00:00.000Z", cursor: null },
      { projectKey: "ABC", since: "2026-10-25T12:00:00.000Z", cursor: "p2" },
      { projectKey: "XYZ", since: "2026-10-25T12:00:00.000Z", cursor: null },
    ]);
    expect(result).toEqual({
      upserted: 2,
      projects: [
        { projectKey: "ABC", seen: 2, upserted: 2 },
        { projectKey: "XYZ", seen: 0, upserted: 0 },
      ],
    });
    expect(workItems.items().map((item) => item.platformKey)).toEqual([
      "ABC-1",
      "ABC-2",
    ]);
    expect(workItems.items()[1]).toMatchObject({
      platform: "jira",
      labels: ["jira"],
      url: "https://acme.atlassian.net/browse/ABC-2",
      fields: { jiraLabels: ["bug"] },
    });
  });

  test("a later run resumes from each key's newest item minus the overlap", async () => {
    const workItems = fakeWorkItems({
      items: [
        {
          platform: "jira",
          platformKey: "ABC-1",
          title: "Old",
          description: "Old",
          sourceUpdatedAt: "2026-11-24T11:00:00.000Z",
        },
        {
          platform: "jira",
          platformKey: "XYZ-9",
          title: "Old",
          description: "Old",
          sourceUpdatedAt: "2026-11-23T08:00:00.000Z",
        },
      ],
    });
    const { source, requests } = fakeSource({
      ABC: [
        {
          issues: [
            issue("ABC-1", "2026-11-24T11:00:00.000Z"),
            issue("ABC-1x", "2026-11-24T11:30:00.000Z"),
          ],
          next: null,
        },
      ],
    });
    const result = await runJiraIssueImport(options(source, workItems));
    expect(requests.map((r) => r.since)).toEqual([
      new Date(
        Date.parse("2026-11-24T11:00:00.000Z") - JIRA_CURSOR_OVERLAP_MS,
      ).toISOString(),
      new Date(
        Date.parse("2026-11-23T08:00:00.000Z") - JIRA_CURSOR_OVERLAP_MS,
      ).toISOString(),
    ]);
    // The overlap re-reads ABC-1, which isn't newer, so only ABC-1x counts.
    expect(result.projects[0]).toEqual({
      projectKey: "ABC",
      seen: 2,
      upserted: 1,
    });
  });

  test("an issue moved in from another project isn't written under this key", async () => {
    const { source } = fakeSource({
      ABC: [
        { issues: [issue("OLD-3", "2026-11-24T11:00:00.000Z")], next: null },
      ],
    });
    const workItems = fakeWorkItems();
    const result = await runJiraIssueImport(options(source, workItems));
    expect(result.projects[0]).toEqual({
      projectKey: "ABC",
      seen: 1,
      upserted: 0,
    });
    expect(workItems.items()).toEqual([]);
  });

  test("a failing page keeps earlier pages and stops", async () => {
    let calls = 0;
    const source: JiraSourceClient = {
      searchIssuesUpdatedSince: () => {
        calls += 1;
        if (calls === 1) {
          return Promise.resolve({
            issues: [issue("ABC-1", "2026-11-20T10:00:00.000Z")],
            next: "p2",
          });
        }
        return Promise.reject(new McpToolError("Jira is down", []));
      },
    };
    const workItems = fakeWorkItems();
    expect(
      await rejection(runJiraIssueImport(options(source, workItems))),
    ).toBeInstanceOf(McpToolError);
    expect(workItems.items().map((item) => item.platformKey)).toEqual([
      "ABC-1",
    ]);
  });

  test("a refused upsert fails the run", async () => {
    const { source } = fakeSource({
      ABC: [
        { issues: [issue("ABC-1", "2026-11-20T10:00:00.000Z")], next: null },
      ],
    });
    const workItems = fakeWorkItems();
    expect(
      await rejection(
        runJiraIssueImport({
          ...options(source, workItems),
          labels: ["other"],
        }),
      ),
    ).toBeInstanceOf(WorkItemsRefusedError);
    expect(workItems.items()).toEqual([]);
  });

  test("an issue with no updated time fails", async () => {
    const broken = issue("ABC-1", "");
    const { source } = fakeSource({ ABC: [{ issues: [broken], next: null }] });
    expect(
      (await rejection(runJiraIssueImport(options(source, fakeWorkItems()))))
        .message,
    ).toMatch(/ABC-1 has no updated time/);
  });
});

describe("jiraIssueImport", () => {
  test("grants read, and create and update per project key, under its label", () => {
    expect(toStepSpec(importJira)).toMatchObject({
      key: "import-jira",
      kind: "code",
      name: "Import Jira issues (ABC, XYZ)",
      grants: [
        { action: "read", scope: "project" },
        {
          action: "create",
          scope: "project",
          keyPrefix: "ABC-",
          labels: ["jira"],
        },
        {
          action: "update",
          scope: "project",
          keyPrefix: "ABC-",
          labels: ["jira"],
        },
        {
          action: "create",
          scope: "project",
          keyPrefix: "XYZ-",
          labels: ["jira"],
        },
        {
          action: "update",
          scope: "project",
          keyPrefix: "XYZ-",
          labels: ["jira"],
        },
      ],
    });
  });

  test("the user's module is where the worker finds its fn", () => {
    expect(findCodeStepInModule({ importJira }, "import-jira")).toBe(
      importJira.entrypoint?.fn,
    );
  });

  test("its fn runs the import over context.mcp and context.workItems", async () => {
    const mcp = createFakeMcpClients(
      { atlassian: atlassianServerFor({ type: "oauth" }).handle },
      {
        atlassian: {
          searchJiraIssuesUsingJql: () => ({
            content: [],
            structuredContent: {
              data: {
                issues: [issue("ABC-7", "2026-11-24T11:00:00.000+0000")],
                isLast: true,
              },
            },
          }),
        },
      },
    );
    const workItems = fakeWorkItems();
    const fn = jiraImportFn({
      site,
      projectKeys: ["ABC"],
      labels: ["jira"],
      now: () => now,
    });
    expect(await fn({}, { mcp, workItems })).toEqual({
      upserted: 1,
      projects: [{ projectKey: "ABC", seen: 1, upserted: 1 }],
    });
    expect(workItems.items()[0]).toMatchObject({
      platformKey: "ABC-7",
      sourceUpdatedAt: "2026-11-24T11:00:00.000Z",
    });
  });

  test.each([
    [{ projectKeys: ["abc"] }, /project key "abc"/],
    [{ projectKeys: ["ABC", "ABC"] }, /more than once/],
    [{ site: "acme.atlassian.net" }, /is not a URL/],
    [{ site: "http://acme.atlassian.net" }, /https/],
    [{ firstSyncHorizonDays: 0 }, /firstSyncHorizonDays/],
  ])("rejects %p", (patch, message) => {
    expect(() =>
      jiraIssueImport({
        key: "import-jira",
        site,
        projectKeys: ["ABC"],
        ...(patch as object),
      }),
    ).toThrow(message);
  });

  test("schedule returns a rule that starts the step every 5 minutes by default", () => {
    const automation = defineAutomation({
      key: "jira-intake",
      title: "Jira intake",
      scope: "project",
      rules: [jiraIssueImport.schedule(importJira)],
    });
    expect(JSON.stringify(automation)).toContain("*/5 * * * *");
    expect(JSON.stringify(automation)).toContain("import-jira");
  });

  test("schedule takes a cron, timezone and key", () => {
    const rule = jiraIssueImport.schedule(importJira, {
      cron: "0 * * * *",
      timezone: "Europe/London",
      key: "hourly",
    });
    expect(rule.key).toBe("hourly");
    const automation = defineAutomation({
      key: "jira-intake",
      title: "Jira intake",
      scope: "project",
      rules: [rule],
    });
    const text = JSON.stringify(automation);
    expect(text).toContain("0 * * * *");
    expect(text).toContain("Europe/London");
  });
});
