import { describe, expect, test } from "bun:test";
import {
  grantSentence,
  workItemPrompt,
} from "../src/definitions/steps/work-item-features";

describe("grantSentence", () => {
  test("names the action and scope", () => {
    expect(
      grantSentence({ resource: "workItem", action: "read", scope: "self" }),
    ).toBe("Read your work item.");
    expect(
      grantSentence({
        resource: "workItem",
        action: "comment",
        scope: "children",
      }),
    ).toBe("Comment on its child work items.");
    expect(
      grantSentence({ resource: "workItem", action: "block", scope: "self" }),
    ).toBe("Mark your work item as blocked.");
    expect(
      grantSentence({ resource: "workItem", action: "read", scope: "project" }),
    ).toBe("Read any work item in this project.");
  });

  test("lists the labels a grant is limited to", () => {
    expect(
      grantSentence({
        resource: "workItem",
        action: "label",
        scope: "self",
        labels: ["bug"],
      }),
    ).toBe("Add or remove labels on your work item, with the label `bug`.");
    expect(
      grantSentence({
        resource: "workItem",
        action: "create",
        scope: "children",
        labels: ["bug", "chore"],
      }),
    ).toBe(
      "Create child work items of your work item, with the labels `bug`, `chore`.",
    );
  });

  test("names a project grant's key prefix", () => {
    expect(
      grantSentence({
        resource: "workItem",
        action: "create",
        scope: "project",
        labels: ["imported"],
        keyPrefix: "jira:",
      }),
    ).toBe(
      "Create top-level work items in this project, only items whose `platformKey` starts with `jira:`, with the label `imported`.",
    );
    expect(
      grantSentence({
        resource: "workItem",
        action: "update",
        scope: "project",
      }),
    ).toBe(
      "Write work items this project already has, through `context.workItems.upsert`, including closing and reopening them.",
    );
  });
});

describe("workItemPrompt", () => {
  test("is the section a step's feature appends", () => {
    expect(
      workItemPrompt({ resource: "workItem", action: "close", scope: "self" }),
    ).toBe(
      "## Work Items: Close Your Work Item\n\nYou may close your work item. Use the `scarn-close-work-item` tool.",
    );
  });
});
