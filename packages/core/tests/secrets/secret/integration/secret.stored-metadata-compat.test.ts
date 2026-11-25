/**
 * Stored `secrets` rows stay readable as the metadata contracts evolve. Rows
 * are written directly, bypassing the entity, to stand in for secrets saved
 * by older code. See `docs/persistence/json-columns.md`.
 */
import { describe, expect } from "bun:test";
import { inArray } from "drizzle-orm";
import type { Logger } from "@scarn/observability/logging";
import { getDb } from "@/lib/db";
import { secrets } from "@/lib/db/schema";
import { createUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import type { SecretKind } from "@/secrets/secret/domain/secret-entity";
import { userSecretOwner } from "@/secrets/secret/domain/secret-owner";
import { DrizzleSecretRepo } from "@/secrets/secret/infra/drizzle-secret-repo";
import { concurrentTest } from "tests/utils";
import v1JiraFixture from "../fixtures/v1-jira-api-key.json";
import v1GitHubFixture from "../fixtures/v1-github-token.json";
import v1BitbucketFixture from "../fixtures/v1-bitbucket-api-token.json";

type StoredRow = {
  schemaVersion: number;
  kind: Exclude<SecretKind, "project_secret">;
  metadataJson: unknown;
};

const recordingLogger = () => {
  const errors: unknown[][] = [];
  const logger = {
    error: (...args: unknown[]) => errors.push(args),
  } as unknown as Logger;
  return { logger, errors };
};

const insertRow = async (
  ownerUserId: UuidV7,
  row: StoredRow,
): Promise<UuidV7> => {
  const id = createUuidV7();
  await getDb()
    .insert(secrets)
    .values({
      id,
      ownerUserId,
      kind: row.kind,
      name: `stored metadata compat ${id}`,
      metadataJson: row.metadataJson,
      schemaVersion: row.schemaVersion,
      ciphertext: Buffer.from("fake-ciphertext"),
      iv: Buffer.from("fake-iv"),
      authTag: Buffer.from("fake-tag"),
      keyVersion: 1,
      lastFour: "abcd",
      expiresAt: new Date("2099-01-01T00:00:00.000Z"),
    });
  return id;
};

describe("secret stored metadata compatibility", () => {
  concurrentTest(
    "reads each v1 fixture row, skips an unreadable one in lists and throws on it alone",
    async () => {
      const ownerUserId = createUuidV7();
      const owner = userSecretOwner(ownerUserId);
      const { logger, errors } = recordingLogger();
      const repo = new DrizzleSecretRepo(logger);
      const ids: UuidV7[] = [];
      try {
        const githubId = await insertRow(
          ownerUserId,
          v1GitHubFixture as StoredRow,
        );
        ids.push(
          githubId,
          await insertRow(ownerUserId, v1JiraFixture as StoredRow),
          await insertRow(ownerUserId, v1BitbucketFixture as StoredRow),
        );
        const unreadableId = await insertRow(ownerUserId, {
          schemaVersion: 1,
          kind: "jira_api_key",
          metadataJson: v1GitHubFixture.metadataJson,
        });

        const readableIds = [...ids];
        ids.push(unreadableId);

        const listed = await repo.listByOwner(owner);
        expect(listed.map((secret) => secret.id).sort()).toEqual(
          [...readableIds].sort(),
        );
        expect(
          Object.fromEntries(
            listed.map((secret) => [secret.kind, secret.toJSON().metadataJson]),
          ),
        ).toEqual({
          jira_api_key: v1JiraFixture.metadataJson,
          github_token: v1GitHubFixture.metadataJson,
          bitbucket_api_token: v1BitbucketFixture.metadataJson,
        });
        expect(errors).toHaveLength(1);
        expect(errors[0]?.[0]).toMatchObject({
          table: "secrets",
          secretId: unreadableId,
        });

        expect(
          (await repo.listByOwner(owner, { kind: "github_token" })).map(
            (secret) => secret.id,
          ),
        ).toEqual([githubId]);

        let thrown: unknown = null;
        try {
          await repo.findByIdForOwner(unreadableId, owner);
        } catch (error: unknown) {
          thrown = error;
        }
        expect(thrown).toMatchObject({ code: "SECRET_ROW_UNREADABLE" });
      } finally {
        await getDb().delete(secrets).where(inArray(secrets.id, ids));
      }
    },
  );
});
