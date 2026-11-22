import { describe, expect, test } from "bun:test";
import { parseUuidV7 } from "@/common/contracts/uuid-v7";
import {
  bitbucketStateToWorkItemState,
  mapBitbucketIssueToWorkItem,
} from "@/integrations/bitbucket-ingest/application/map-bitbucket-issue-to-work-item";
import type { BitbucketIssue } from "@/integrations/bitbucket-ingest/infra/bitbucket-client";

const projectId = parseUuidV7("0196917c-532c-75aa-b7d5-0a84b71a1f02");

const baseIssue: BitbucketIssue = {
  id: 12,
  title: "Login is broken",
  state: "open",
  kind: "bug",
  priority: "major",
  content: { raw: "Steps to reproduce" },
  reporter: { display_name: "Rae" },
  assignee: null,
  created_on: "2026-01-01T00:00:00.000000+00:00",
  updated_on: "2026-01-02T00:00:00.000000+00:00",
  votes: 3,
  links: { html: { href: "https://bitbucket.org/team/api/issues/12" } },
};

describe("mapBitbucketIssueToWorkItem", () => {
  test("maps a Bitbucket issue to a bitbucket work item keyed by repo and id", () => {
    const item = mapBitbucketIssueToWorkItem({
      projectId,
      repoFullName: "team/api",
      issue: baseIssue,
    });

    expect(item).toMatchObject({
      projectId,
      platform: "bitbucket",
      platformKey: "team/api#12",
      url: "https://bitbucket.org/team/api/issues/12",
      title: "Login is broken",
      description: "Steps to reproduce",
      sourceCreatedAt: baseIssue.created_on,
      sourceUpdatedAt: baseIssue.updated_on,
      state: "open",
      fields: {
        repository: "team/api",
        number: 12,
        state: "open",
        kind: "bug",
        priority: "major",
        reporter: "Rae",
        assignee: null,
        votes: 3,
      },
    });
  });

  test("fills a missing description and link", () => {
    const item = mapBitbucketIssueToWorkItem({
      projectId,
      repoFullName: "team/api",
      issue: { ...baseIssue, content: { raw: "  " }, links: null },
    });

    expect(item.description).toBe("(No description provided.)");
    expect(item.url).toBe("https://bitbucket.org/team/api/issues/12");
  });

  test.each([
    ["new", "open"],
    ["open", "open"],
    ["on hold", "open"],
    ["resolved", "closed"],
    ["closed", "closed"],
    ["invalid", "closed"],
    ["duplicate", "closed"],
    ["wontfix", "closed"],
  ] as const)("state %s is %s", (state, expected) => {
    expect(bitbucketStateToWorkItemState(state)).toBe(expected);
  });
});
