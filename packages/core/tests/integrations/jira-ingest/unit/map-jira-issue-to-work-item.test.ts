import { describe, expect, test } from "bun:test";
import { mapJiraIssueToWorkItem } from "@/integrations/jira-ingest/application/map-jira-issue-to-work-item";
import type { JiraIssue } from "@/integrations/jira-ingest/infra/jira-issues-client";
import { parseUuidV7 } from "@/common/contracts/uuid-v7";

const projectId = parseUuidV7("0196917c-532c-75aa-b7d5-0a84b71a1f02");
const baseUrl = "https://acme.atlassian.net";
const emptyFieldNameMap = new Map<string, string>();

const baseIssue: JiraIssue = {
  id: "10001",
  key: "ENG-42",
  fields: {
    summary: "Login fails on Safari",
    description: null,
    created: "2026-04-22T11:00:00.000+0000",
    updated: "2026-04-22T12:00:00.000+0000",
    status: { name: "In Progress" },
    priority: { name: "High" },
    issuetype: { name: "Bug" },
    assignee: { displayName: "Alice" },
    reporter: { displayName: "Bob" },
    labels: ["frontend", "auth"],
    comment: { total: 3 },
  },
} as unknown as JiraIssue;

describe("mapJiraIssueToWorkItem", () => {
  test("normalizes Jira +0000 offset to valid ISO datetime", () => {
    const result = mapJiraIssueToWorkItem(
      projectId,
      baseUrl,
      baseIssue,
      emptyFieldNameMap,
    );
    expect(result.sourceCreatedAt).toBe("2026-04-22T11:00:00.000Z");
    expect(result.sourceUpdatedAt).toBe("2026-04-22T12:00:00.000Z");
  });

  test("normalizes Jira +HH:MM offset to valid ISO datetime", () => {
    const issue = {
      ...baseIssue,
      fields: {
        ...baseIssue.fields,
        created: "2026-04-22T14:00:00.000+05:30",
        updated: "2026-04-22T15:00:00.000+05:30",
      },
    };
    const result = mapJiraIssueToWorkItem(
      projectId,
      baseUrl,
      issue,
      emptyFieldNameMap,
    );
    expect(result.sourceCreatedAt).toBe("2026-04-22T08:30:00.000Z");
    expect(result.sourceUpdatedAt).toBe("2026-04-22T09:30:00.000Z");
  });

  test("falls back to placeholder when description is null", () => {
    const result = mapJiraIssueToWorkItem(
      projectId,
      baseUrl,
      baseIssue,
      emptyFieldNameMap,
    );
    expect(result.description).toBe("(No description provided.)");
  });

  test("falls back to placeholder when description is empty ADF", () => {
    const issue = {
      ...baseIssue,
      fields: {
        ...baseIssue.fields,
        description: { type: "doc", content: [] },
      },
    } as unknown as JiraIssue;
    const result = mapJiraIssueToWorkItem(
      projectId,
      baseUrl,
      issue,
      emptyFieldNameMap,
    );
    expect(result.description).toBe("(No description provided.)");
  });

  test("extracts plain text from ADF description", () => {
    const issue = {
      ...baseIssue,
      fields: {
        ...baseIssue.fields,
        description: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "Repro: open Safari → boom." }],
            },
          ],
        },
      },
    } as unknown as JiraIssue;
    const result = mapJiraIssueToWorkItem(
      projectId,
      baseUrl,
      issue,
      emptyFieldNameMap,
    );
    expect(result.description).toContain("Repro");
  });

  test("maps core fields correctly", () => {
    const result = mapJiraIssueToWorkItem(
      projectId,
      baseUrl,
      baseIssue,
      emptyFieldNameMap,
    );
    expect(result.projectId).toBe(projectId);
    expect(result.platform).toBe("jira");
    expect(result.platformId).toBe("10001");
    expect(result.platformKey).toBe("ENG-42");
    expect(result.url).toBe("https://acme.atlassian.net/browse/ENG-42");
    expect(result.title).toBe("Login fails on Safari");
    expect(result.labels).toEqual(["frontend", "auth"]);
    expect(result.fields).toMatchObject({
      status: "In Progress",
      priority: "High",
      issueType: "Bug",
      assignee: "Alice",
      reporter: "Bob",
      commentsCount: 3,
    });
    expect(result.fields).not.toHaveProperty("labels");
  });

  test("an issue with no labels maps to an empty list, so sync clears them", () => {
    const issue = {
      ...baseIssue,
      fields: { ...baseIssue.fields, labels: undefined },
    } as unknown as JiraIssue;
    const result = mapJiraIssueToWorkItem(
      projectId,
      baseUrl,
      issue,
      emptyFieldNameMap,
    );
    expect(result.labels).toEqual([]);
  });

  test("maps custom fields using pretty names from fieldNameMap", () => {
    const fieldNameMap = new Map([
      ["customfield_10016", "Story Points"],
      ["customfield_10020", "Sprint"],
    ]);
    const issue = {
      ...baseIssue,
      fields: {
        ...baseIssue.fields,
        customfield_10016: 5,
        customfield_10020: { name: "Sprint 42" },
      },
    } as unknown as JiraIssue;
    const result = mapJiraIssueToWorkItem(
      projectId,
      baseUrl,
      issue,
      fieldNameMap,
    );
    expect(result.fields).toMatchObject({
      "Story Points": 5,
      Sprint: "Sprint 42",
    });
  });

  test("extracts plain text from ADF custom fields", () => {
    const fieldNameMap = new Map([["customfield_10770", "Company"]]);
    const issue = {
      ...baseIssue,
      fields: {
        ...baseIssue.fields,
        customfield_10770: {
          type: "doc",
          version: 1,
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "Arrowpoint Engineering" }],
            },
          ],
        },
      },
    } as unknown as JiraIssue;
    const result = mapJiraIssueToWorkItem(
      projectId,
      baseUrl,
      issue,
      fieldNameMap,
    );
    expect(result.fields).toMatchObject({ Company: "Arrowpoint Engineering" });
  });

  test("omits null custom fields", () => {
    const fieldNameMap = new Map([["customfield_10016", "Story Points"]]);
    const issue = {
      ...baseIssue,
      fields: { ...baseIssue.fields, customfield_10016: null },
    } as unknown as JiraIssue;
    const result = mapJiraIssueToWorkItem(
      projectId,
      baseUrl,
      issue,
      fieldNameMap,
    );
    expect(result.fields).not.toHaveProperty("Story Points");
  });

  describe("state", () => {
    const issueWithStatus = (status: Record<string, unknown>) =>
      ({
        ...baseIssue,
        fields: { ...baseIssue.fields, status },
      }) as unknown as JiraIssue;

    test.each([
      ["done", "closed"],
      ["new", "open"],
      ["indeterminate", "open"],
    ] as const)(
      "maps statusCategory %s to %s",
      (categoryKey, expectedState) => {
        const issue = issueWithStatus({
          name: "Whatever",
          statusCategory: { key: categoryKey },
        });
        const result = mapJiraIssueToWorkItem(
          projectId,
          baseUrl,
          issue,
          emptyFieldNameMap,
        );
        expect(result.state).toBe(expectedState);
      },
    );

    test("defaults to open when statusCategory is missing", () => {
      const result = mapJiraIssueToWorkItem(
        projectId,
        baseUrl,
        baseIssue,
        emptyFieldNameMap,
      );
      expect(result.state).toBe("open");
    });

    test("keeps the status name in fields when closed", () => {
      const issue = issueWithStatus({
        name: "Done",
        statusCategory: { key: "done" },
      });
      const result = mapJiraIssueToWorkItem(
        projectId,
        baseUrl,
        issue,
        emptyFieldNameMap,
      );
      expect(result.fields).toMatchObject({ status: "Done" });
    });
  });
});
