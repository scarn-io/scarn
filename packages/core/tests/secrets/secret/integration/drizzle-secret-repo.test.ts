import { describe, expect } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { concurrentTest } from "tests/utils";
import { getDb } from "@/lib/db";
import { projects, secrets } from "@/lib/db/schema";
import { createUuidV7 } from "@/common/contracts/uuid-v7";
import { ProjectSecretEntity } from "@/secrets/secret/domain/secret-entity";
import {
  projectSecretOwner,
  userSecretOwner,
} from "@/secrets/secret/domain/secret-owner";
import { DrizzleSecretRepo } from "@/secrets/secret/infra/drizzle-secret-repo";

describe("DrizzleSecretRepo.listSummariesByIds", () => {
  const repo = new DrizzleSecretRepo();

  concurrentTest(
    "returns only id, name and owner for any owner's secrets, omitting unknown ids",
    async () => {
      const ownerA = createUuidV7();
      const ownerB = createUuidV7();
      const teamKey = {
        id: createUuidV7(),
        ownerUserId: ownerA,
        name: "Team Jira key",
      };
      const myToken = {
        id: createUuidV7(),
        ownerUserId: ownerB,
        name: "My GitHub token",
      };
      const rows = [teamKey, myToken];
      await getDb()
        .insert(secrets)
        .values(
          rows.map((row) => ({
            ...row,
            kind: "jira_api_key" as const,
            metadataJson: {},
            schemaVersion: 1,
            ciphertext: Buffer.from("ciphertext"),
            iv: Buffer.from("iv"),
            authTag: Buffer.from("tag"),
            keyVersion: 1,
            lastFour: "wxyz",
          })),
        );
      try {
        const summaries = await repo.listSummariesByIds([
          teamKey.id,
          myToken.id,
          createUuidV7(),
        ]);

        expect(
          [...summaries].sort((a, b) => a.name.localeCompare(b.name)),
        ).toEqual([myToken, teamKey]);
        expect(await repo.listSummariesByIds([])).toEqual([]);
      } finally {
        await getDb()
          .delete(secrets)
          .where(
            inArray(
              secrets.id,
              rows.map((row) => row.id),
            ),
          );
      }
    },
  );
});

describe("DrizzleSecretRepo.findById", () => {
  const repo = new DrizzleSecretRepo();

  concurrentTest(
    "loads any owner's secret with its ciphertext, and null for an unknown id",
    async () => {
      const ownerUserId = createUuidV7();
      const id = createUuidV7();
      await getDb()
        .insert(secrets)
        .values({
          id,
          ownerUserId,
          name: "Lent Jira key",
          kind: "jira_api_key",
          metadataJson: { email: "owner@example.com" },
          schemaVersion: 1,
          ciphertext: Buffer.from("ciphertext"),
          iv: Buffer.from("iv"),
          authTag: Buffer.from("tag"),
          keyVersion: 1,
          lastFour: "wxyz",
          expiresAt: new Date("2099-01-01T00:00:00.000Z"),
        });
      try {
        const secret = await repo.findById(id);

        expect(secret?.id).toBe(id);
        expect(secret?.kind).toBe("jira_api_key");
        expect(secret?.owner).toEqual({ type: "user", userId: ownerUserId });
        expect(secret?.encryptedValue.ciphertext).toEqual(
          Buffer.from("ciphertext"),
        );
        expect(await repo.findById(createUuidV7())).toBeNull();
      } finally {
        await getDb().delete(secrets).where(eq(secrets.id, id));
      }
    },
  );
});

describe("DrizzleSecretRepo with a project owner", () => {
  const repo = new DrizzleSecretRepo();
  const encryptedValue = {
    ciphertext: Buffer.from("ciphertext"),
    iv: Buffer.alloc(12),
    authTag: Buffer.alloc(16),
    keyVersion: 1,
  };

  const insertProject = async () => {
    const projectId = createUuidV7();
    await getDb()
      .insert(projects)
      .values({
        id: projectId,
        name: "Project secrets test project",
        slug: `project-secrets-${crypto.randomUUID()}`,
        gitUrl: "https://github.com/example/test-project.git",
        createdByUserId: createUuidV7(),
        orgId: createUuidV7(),
      });
    return projectId;
  };

  const projectSecret = (
    projectId: ReturnType<typeof createUuidV7>,
    name: string,
  ) =>
    ProjectSecretEntity.create({
      owner: projectSecretOwner(projectId),
      name,
      encryptedValue,
      lastFour: "abcd",
      now: new Date("2026-10-20T12:00:00.000Z"),
    });

  concurrentTest(
    "saves and reloads a project secret scoped to its project, and drops it with the project",
    async () => {
      const projectId = await insertProject();
      const otherProjectId = await insertProject();
      const owner = projectSecretOwner(projectId);
      try {
        const saved = await repo.save(projectSecret(projectId, "API_KEY"));

        expect(saved).toBeInstanceOf(ProjectSecretEntity);
        expect(saved.toJSON()).toMatchObject({
          owner,
          kind: "project_secret",
          valueKind: "static",
          name: "API_KEY",
          expiresAt: null,
        });
        expect((await repo.findByIdForOwner(saved.id, owner))?.id).toBe(
          saved.id,
        );
        expect(
          await repo.findByIdForOwner(
            saved.id,
            projectSecretOwner(otherProjectId),
          ),
        ).toBeNull();
        expect(
          await repo.findByIdForOwner(saved.id, userSecretOwner(projectId)),
        ).toBeNull();
        expect(
          (await repo.listByOwner(owner)).map((secret) => secret.id),
        ).toEqual([saved.id]);
        expect(await repo.listSummariesByIds([saved.id])).toEqual([]);

        await getDb().delete(projects).where(eq(projects.id, projectId));
        expect(await repo.findById(saved.id)).toBeNull();
      } finally {
        await getDb()
          .delete(projects)
          .where(inArray(projects.id, [projectId, otherProjectId]));
      }
    },
  );

  concurrentTest(
    "rejects a duplicate name within a project but not across projects",
    async () => {
      const projectId = await insertProject();
      const otherProjectId = await insertProject();
      try {
        await repo.save(projectSecret(projectId, "API_KEY"));
        await repo.save(projectSecret(otherProjectId, "API_KEY"));

        let duplicate: Error | null = null;
        try {
          await repo.save(projectSecret(projectId, "API_KEY"));
        } catch (error) {
          duplicate = error as Error;
        }
        expect(duplicate).toMatchObject({ code: "SECRET_NAME_TAKEN" });
      } finally {
        await getDb()
          .delete(projects)
          .where(inArray(projects.id, [projectId, otherProjectId]));
      }
    },
  );

  concurrentTest(
    "the database rejects a row with no owner or both owners",
    async () => {
      const projectId = await insertProject();
      const base = {
        kind: "project_secret" as const,
        name: "API_KEY",
        metadataJson: {},
        schemaVersion: 1,
        ciphertext: Buffer.from("ciphertext"),
        iv: Buffer.from("iv"),
        authTag: Buffer.from("tag"),
        keyVersion: 1,
        lastFour: "wxyz",
      };
      try {
        for (const owners of [
          {},
          { ownerUserId: createUuidV7(), ownerProjectId: projectId },
        ]) {
          const id = createUuidV7();
          const result = await getDb()
            .insert(secrets)
            .values({ ...base, ...owners, id })
            .then(
              () => "inserted",
              () => "rejected",
            );
          expect(result).toBe("rejected");
        }
      } finally {
        await getDb().delete(projects).where(eq(projects.id, projectId));
      }
    },
  );
});
