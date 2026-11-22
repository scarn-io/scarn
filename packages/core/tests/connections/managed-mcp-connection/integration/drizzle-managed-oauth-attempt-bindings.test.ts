import { describe, expect } from "bun:test";
import { eq } from "drizzle-orm";
import { createUuidV7 } from "@/common/contracts/uuid-v7";
import {
  ManagedConnectionEntity,
  type ManagedConnectionEntity as ManagedConnection,
} from "@/connections/managed-mcp-connection/domain/managed-connection-entity";
import {
  ManagedOAuthAttemptEntity,
  type ManagedOAuthAttemptBinding,
} from "@/connections/managed-mcp-connection/domain/managed-oauth-attempt-entity";
import { DrizzleManagedConnectionRepo } from "@/connections/managed-mcp-connection/infra/drizzle-managed-connection-repo";
import { DrizzleManagedOAuthAttemptRepo } from "@/connections/managed-mcp-connection/infra/drizzle-managed-oauth-attempt-repo";
import { managedConnectionDefinitionFromPreset } from "@/connections/managed-mcp-connection/infra/managed-connection-presets";
import { getDb } from "@/lib/db";
import { managedOAuthAttempts, projects } from "@/lib/db/schema";
import { expectPgError } from "tests/lib/db/orchestration-schema-test-support";
import { concurrentTest } from "tests/utils";

const NOW = new Date("2026-11-17T12:00:00.000Z");

const ciphertext = () => ({
  ciphertext: Buffer.from("ciphertext"),
  iv: Buffer.from("iv"),
  authTag: Buffer.from("tag"),
  keyVersion: 1,
});

/** An attempt is bound to a browser session or a loopback completion secret. */
describe("drizzle managed OAuth attempt repo: bindings", () => {
  const startConnecting = async () => {
    const projectId = createUuidV7();
    await getDb()
      .insert(projects)
      .values({
        id: projectId,
        name: "Managed attempt binding project",
        slug: `managed-attempt-binding-${crypto.randomUUID()}`,
        gitUrl: "https://github.com/example/test-project.git",
        createdByUserId: createUuidV7(),
        orgId: createUuidV7(),
      });
    const connection = ManagedConnectionEntity.create({
      projectId,
      ...managedConnectionDefinitionFromPreset("notion"),
      now: NOW,
    }).startConnect(NOW);
    await new DrizzleManagedConnectionRepo().insert(connection);
    return { connection };
  };

  const newAttempt = (
    connection: ManagedConnection,
    binding: ManagedOAuthAttemptBinding,
  ) =>
    ManagedOAuthAttemptEntity.create({
      id: createUuidV7(),
      connectionId: connection.id,
      projectId: connection.projectId,
      kind: "connect",
      expectedGeneration: connection.generation,
      actorUserId: createUuidV7(),
      binding,
      stateDigest: crypto.randomUUID(),
      clientId: "https://scarn.test/client",
      redirectUri: "http://127.0.0.1:53682/callback",
      requestedScopes: ["default"],
      encryptedPkceVerifier: ciphertext(),
      now: NOW,
    });

  concurrentTest(
    "browser and loopback attempts round-trip their binding",
    async () => {
      const { connection } = await startConnecting();
      const attemptRepo = new DrizzleManagedOAuthAttemptRepo();
      const browser = newAttempt(connection, {
        kind: "browser",
        sessionDigest: crypto.randomUUID(),
      });
      const loopback = newAttempt(connection, {
        kind: "loopback",
        secretDigest: crypto.randomUUID(),
      });
      await attemptRepo.insert(browser);
      await attemptRepo.insert(loopback);

      for (const attempt of [browser, loopback]) {
        const stored = await attemptRepo.findByStateDigest(attempt.stateDigest);
        expect(stored?.binding).toEqual(attempt.binding);
        expect(stored?.redirectUri).toBe(attempt.redirectUri);
      }
      const [row] = await getDb()
        .select()
        .from(managedOAuthAttempts)
        .where(eq(managedOAuthAttempts.id, loopback.id));
      expect(row?.completion).toBe("loopback");
      expect(row?.browserSessionDigest).toBeNull();
    },
  );

  concurrentTest(
    "the database rejects an attempt whose binding digest doesn't match its completion",
    async () => {
      const { connection } = await startConnecting();
      const attempt = newAttempt(connection, {
        kind: "browser",
        sessionDigest: crypto.randomUUID(),
      });
      await new DrizzleManagedOAuthAttemptRepo().insert(attempt);
      const update = (
        values: Partial<typeof managedOAuthAttempts.$inferInsert>,
      ) =>
        getDb()
          .update(managedOAuthAttempts)
          .set(values)
          .where(eq(managedOAuthAttempts.id, attempt.id));
      const constraint = {
        code: "23514",
        constraint: "managed_oauth_attempts_completion_check",
      };

      await expectPgError(() => update({ completion: "loopback" }), constraint);
      await expectPgError(
        () => update({ completionSecretDigest: "secret-digest" }),
        constraint,
      );
      await expectPgError(
        () => update({ browserSessionDigest: null }),
        constraint,
      );
      await expectPgError(
        () =>
          update({
            completion: "elsewhere",
            browserSessionDigest: null,
            completionSecretDigest: "secret-digest",
          }),
        constraint,
      );
      await update({
        completion: "loopback",
        browserSessionDigest: null,
        completionSecretDigest: "secret-digest",
      });
    },
  );
});
