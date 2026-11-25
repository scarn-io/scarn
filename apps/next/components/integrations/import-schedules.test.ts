import { describe, expect, test } from "bun:test";
import type { AutomationListItemContract } from "@scarn/api/frontend-contracts";
import type { Grant } from "@scarn/sdk/definitions/steps";
import { poller } from "@/components/pipelines/pipeline-page-tabs-fixtures";
import { importSchedulesFor } from "./import-schedules";

const importer = (
  stepKey: string,
  overrides: Partial<AutomationListItemContract> = {},
): AutomationListItemContract => ({
  ...poller,
  key: "issue-import",
  title: "Issue import",
  latestVersion: {
    id: poller.id,
    version: 1,
    schemaVersion: 1,
    contentHash: "hash",
    publishedAt: "2026-11-01T12:00:00.000Z",
    document: {
      kind: "automation",
      schemaVersion: 1,
      key: "issue-import",
      scope: "project",
      rules: [
        {
          key: "hourly",
          event: "schedule",
          cron: "0 * * * *",
          next: { routes: [{ kind: "step", to: stepKey }] },
        },
      ],
    },
  },
  ...overrides,
});

const importGrants = (keyPrefix: string): Grant[] => [
  { resource: "workItem", action: "read", scope: "project" },
  {
    resource: "workItem",
    action: "create",
    scope: "project",
    labels: ["jira"],
    keyPrefix,
  },
  { resource: "workItem", action: "update", scope: "project", keyPrefix },
];

const jira = {
  kind: "jira",
  externalScope: { projectKeys: ["ABC"] },
} as const;
const github = {
  kind: "github_token",
  externalScope: { repos: [{ fullName: "acme/api" }] },
} as const;

describe("importSchedulesFor", () => {
  test("finds the schedule whose step imports under the Jira key", () => {
    const grants = new Map([["import-jira", importGrants("ABC-")]]);

    const found = importSchedulesFor(jira, [importer("import-jira")], grants);

    expect(found.map((entry) => entry.schedule.key)).toEqual(["hourly"]);
    expect(found[0]?.automation.title).toBe("Issue import");
  });

  test("matches a GitHub repo by its owner/repo# prefix", () => {
    const grants = new Map([["import-gh", importGrants("acme/api#")]]);

    expect(
      importSchedulesFor(github, [importer("import-gh")], grants),
    ).toHaveLength(1);
  });

  test("skips steps importing other keys, unknown steps and work-item automations", () => {
    const grants = new Map([
      ["import-xyz", importGrants("XYZ-")],
      ["import-abc", importGrants("ABC-")],
    ]);

    expect(
      importSchedulesFor(
        jira,
        [
          importer("import-xyz"),
          importer("unknown"),
          importer("import-abc", { scope: "workItem" }),
        ],
        grants,
      ),
    ).toEqual([]);
  });
});
