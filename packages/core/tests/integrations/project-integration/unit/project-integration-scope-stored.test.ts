import { describe, expect } from "bun:test";
import type { z } from "zod";
import type { AnyJsonValue } from "@/common/contracts/json";
import {
  bitbucketIntegrationScopeSchema,
  githubIntegrationScopeSchema,
  jiraIntegrationScopeSchema,
} from "@/integrations/project-integration/contracts/project-integration-contracts";
import {
  CURRENT_PROJECT_INTEGRATION_SCHEMA_VERSION,
  readStoredProjectIntegrationScope,
} from "@/integrations/project-integration/contracts/project-integration-scope-stored";
import { projectIntegrationFromRow } from "@/integrations/project-integration/infra/drizzle-project-integration-repo";
import { createUuidV7 } from "@/common/contracts/uuid-v7";
import { concurrentTest } from "tests/utils";
import v1GitHubFixture from "../fixtures/v1-github.json";
import v1BitbucketFixture from "../fixtures/v1-bitbucket.json";
import v1JiraFixture from "../fixtures/v1-jira.json";

type Fixture = {
  schemaVersion: number;
  kind: "github_app" | "github_token" | "bitbucket" | "jira";
  installationId: string | null;
  externalScopeJson: AnyJsonValue;
};

const fixtures: readonly (readonly [string, Fixture, z.ZodType])[] = [
  ["github", v1GitHubFixture as Fixture, githubIntegrationScopeSchema],
  ["bitbucket", v1BitbucketFixture as Fixture, bitbucketIntegrationScopeSchema],
  ["jira", v1JiraFixture as Fixture, jiraIntegrationScopeSchema],
];

const thrownBy = (run: () => unknown): unknown => {
  try {
    run();
    return null;
  } catch (error: unknown) {
    return error;
  }
};

const integrationRow = (fixture: Fixture) => ({
  id: createUuidV7(),
  projectId: createUuidV7(),
  kind: fixture.kind,
  installationId: fixture.installationId,
  externalScopeJson: fixture.externalScopeJson,
  schemaVersion: fixture.schemaVersion,
  status: "active" as const,
  lastSyncedAt: null,
  lastError: null,
  firstSyncHorizonDays: null,
  syncSecretId: null,
  syncLockedUntil: null,
  autoSyncPausedReason: null,
  autoSyncPausedAt: null,
  autoSyncPausedDetail: null,
  createdAt: new Date("2026-11-01T00:00:00.000Z"),
  updatedAt: new Date("2026-11-01T00:00:00.000Z"),
});

describe("project integration stored scope read", () => {
  for (const [name, fixture, writeSchema] of fixtures) {
    concurrentTest(`reads the v1 ${name} fixture as stored`, () => {
      const read = readStoredProjectIntegrationScope(
        fixture.schemaVersion,
        fixture,
      );
      if (!read.success) throw new Error(read.reason);
      expect<object>(read.value).toEqual({
        kind: fixture.kind,
        scope: fixture.externalScopeJson,
      });
    });

    concurrentTest(
      `the v1 ${name} fixture still passes the write schema`,
      () => {
        expect(writeSchema.safeParse(fixture.externalScopeJson).success).toBe(
          true,
        );
      },
    );

    concurrentTest(
      `reads the v1 ${name} fixture through the row mapper`,
      () => {
        const integration = projectIntegrationFromRow(integrationRow(fixture));
        expect(integration.kind).toBe(fixture.kind);
        expect(integration.toJSON().externalScopeJson).toEqual(
          fixture.externalScopeJson,
        );
      },
    );
  }

  concurrentTest("reads the GitHub scope for a token integration", () => {
    const integration = projectIntegrationFromRow(
      integrationRow({
        ...(v1GitHubFixture as Fixture),
        kind: "github_token",
        installationId: null,
      }),
    );
    expect(integration.kind).toBe("github_token");
    expect(integration.toJSON().externalScopeJson).toEqual(
      v1GitHubFixture.externalScopeJson,
    );
  });

  concurrentTest("strips unknown scope keys instead of rejecting them", () => {
    const read = readStoredProjectIntegrationScope(1, {
      kind: "jira",
      externalScopeJson: {
        baseUrl: "https://example-site.atlassian.net",
        projectKeys: ["EXA"],
        cloudId: "example-cloud",
      },
    });
    if (!read.success) throw new Error(read.reason);
    expect(read.value).toEqual({
      kind: "jira",
      scope: {
        baseUrl: "https://example-site.atlassian.net",
        projectKeys: ["EXA"],
      },
    });
  });

  concurrentTest(
    "does not reapply write rules (URL, non-empty, at least one entry, duplicates)",
    () => {
      const jira = projectIntegrationFromRow(
        integrationRow({
          schemaVersion: 1,
          kind: "jira",
          installationId: null,
          externalScopeJson: { baseUrl: "not a url", projectKeys: [] },
        }),
      );
      expect(jira.toJSON().externalScopeJson).toEqual({
        baseUrl: "not a url",
        projectKeys: [],
      });

      const github = projectIntegrationFromRow(
        integrationRow({
          schemaVersion: 1,
          kind: "github_app",
          installationId: "10000001",
          externalScopeJson: {
            repos: [
              { id: 1, fullName: "" },
              { id: 1, fullName: "" },
            ],
          },
        }),
      );
      expect(github.toJSON().externalScopeJson).toEqual({
        repos: [
          { id: 1, fullName: "" },
          { id: 1, fullName: "" },
        ],
      });
    },
  );

  concurrentTest("a scope that does not fit its kind is unreadable", () => {
    const read = readStoredProjectIntegrationScope(1, {
      kind: "jira",
      externalScopeJson: v1GitHubFixture.externalScopeJson,
    });
    expect(read.success).toBe(false);
    expect(
      thrownBy(() =>
        projectIntegrationFromRow(
          integrationRow({
            ...(v1GitHubFixture as Fixture),
            kind: "jira",
            installationId: null,
          }),
        ),
      ),
    ).toMatchObject({ code: "PROJECT_INTEGRATION_ROW_UNREADABLE" });
  });

  concurrentTest("an unknown schema version is unreadable", () => {
    const read = readStoredProjectIntegrationScope(
      CURRENT_PROJECT_INTEGRATION_SCHEMA_VERSION + 1,
      v1JiraFixture,
    );
    expect(read.success).toBe(false);
  });
});
