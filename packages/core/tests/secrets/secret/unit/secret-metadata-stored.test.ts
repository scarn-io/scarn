import { describe, expect } from "bun:test";
import type { AnyJsonValue } from "@/common/contracts/json";
import { createUuidV7 } from "@/common/contracts/uuid-v7";
import {
  CURRENT_SECRET_SCHEMA_VERSION,
  readStoredSecretMetadata,
} from "@/secrets/secret/contracts/secret-metadata-stored";
import type { SecretKind } from "@/secrets/secret/domain/secret-entity";
import { secretFromRow } from "@/secrets/secret/infra/drizzle-secret-repo";
import { concurrentTest } from "tests/utils";
import v1JiraFixture from "../fixtures/v1-jira-api-key.json";
import v1GitHubFixture from "../fixtures/v1-github-token.json";
import v1BitbucketFixture from "../fixtures/v1-bitbucket-api-token.json";
import v1ProjectSecretFixture from "../fixtures/v1-project-secret.json";

type Fixture = {
  schemaVersion: number;
  kind: SecretKind;
  metadataJson: AnyJsonValue;
};

const fixtures: readonly (readonly [string, Fixture])[] = [
  ["jira_api_key", v1JiraFixture as Fixture],
  ["github_token", v1GitHubFixture as Fixture],
  ["bitbucket_api_token", v1BitbucketFixture as Fixture],
  ["project_secret", v1ProjectSecretFixture as Fixture],
];

const thrownBy = (run: () => unknown): unknown => {
  try {
    run();
    return null;
  } catch (error: unknown) {
    return error;
  }
};

const secretRow = (fixture: Fixture, name = "Example key") => {
  const ownedByProject = fixture.kind === "project_secret";
  return {
    id: createUuidV7(),
    ownerUserId: ownedByProject ? null : createUuidV7(),
    ownerProjectId: ownedByProject ? createUuidV7() : null,
    kind: fixture.kind,
    valueKind: "static" as const,
    name,
    metadataJson: fixture.metadataJson,
    schemaVersion: fixture.schemaVersion,
    ciphertext: Buffer.from("fake-ciphertext"),
    iv: Buffer.from("fake-iv"),
    authTag: Buffer.from("fake-tag"),
    keyVersion: 1,
    lastFour: "abcd",
    expiresAt: new Date("2099-01-01T00:00:00.000Z"),
    lastUsedAt: null,
    updatedByUserId: null,
    createdAt: new Date("2026-11-01T00:00:00.000Z"),
    updatedAt: new Date("2026-11-01T00:00:00.000Z"),
  };
};

describe("secret stored metadata read", () => {
  for (const [name, fixture] of fixtures) {
    concurrentTest(`reads the v1 ${name} fixture as stored`, () => {
      const read = readStoredSecretMetadata(fixture.schemaVersion, fixture);
      if (!read.success) throw new Error(read.reason);
      expect(read.value.kind).toBe(fixture.kind);
    });

    concurrentTest(
      `reads the v1 ${name} fixture through the row mapper`,
      () => {
        const row = secretRow(fixture);
        const secret = secretFromRow(row);
        expect(secret.kind).toBe(fixture.kind);
        expect(secret.toJSON().metadataJson).toEqual(fixture.metadataJson);
      },
    );
  }

  concurrentTest(
    "strips unknown metadata keys instead of rejecting them",
    () => {
      const read = readStoredSecretMetadata(1, {
        kind: "jira_api_key",
        metadataJson: { email: "person@example.test", siteUrl: "example" },
      });
      if (!read.success) throw new Error(read.reason);
      expect(read.value).toEqual({
        kind: "jira_api_key",
        metadata: { email: "person@example.test" },
      });
    },
  );

  concurrentTest("ignores a project secret's metadata", () => {
    const secret = secretFromRow(
      secretRow({ ...(v1ProjectSecretFixture as Fixture), metadataJson: [] }),
    );
    expect(secret.kind).toBe("project_secret");
  });

  concurrentTest(
    "does not reapply write rules (email format, login trimming, names)",
    () => {
      const jira = secretFromRow(
        secretRow(
          {
            schemaVersion: 1,
            kind: "jira_api_key",
            metadataJson: { email: "Not An Email" },
          },
          "",
        ),
      );
      expect(jira.toJSON()).toMatchObject({
        name: "",
        metadataJson: { email: "Not An Email" },
      });

      const github = secretFromRow(
        secretRow({
          schemaVersion: 1,
          kind: "github_token",
          metadataJson: { login: "  " },
        }),
      );
      expect(github.toJSON().metadataJson).toEqual({ login: "  " });

      const project = secretFromRow(
        secretRow(v1ProjectSecretFixture as Fixture, "lower-case name"),
      );
      expect(project.name).toBe("lower-case name");
    },
  );

  concurrentTest("metadata that does not fit its kind is unreadable", () => {
    const read = readStoredSecretMetadata(1, {
      kind: "github_token",
      metadataJson: v1JiraFixture.metadataJson,
    });
    expect(read.success).toBe(false);
    expect(
      thrownBy(() =>
        secretFromRow(
          secretRow({ ...(v1JiraFixture as Fixture), metadataJson: {} }),
        ),
      ),
    ).toMatchObject({ code: "SECRET_ROW_UNREADABLE" });
  });

  concurrentTest("a row without a required expiry is unreadable", () => {
    expect(
      thrownBy(() =>
        secretFromRow({
          ...secretRow(v1BitbucketFixture as Fixture),
          expiresAt: null,
        }),
      ),
    ).toMatchObject({ code: "SECRET_ROW_UNREADABLE" });
  });

  concurrentTest("an unknown kind or schema version is unreadable", () => {
    expect(
      readStoredSecretMetadata(CURRENT_SECRET_SCHEMA_VERSION + 1, v1JiraFixture)
        .success,
    ).toBe(false);
    expect(
      readStoredSecretMetadata(1, { kind: "env", metadataJson: {} }).success,
    ).toBe(false);
  });
});
