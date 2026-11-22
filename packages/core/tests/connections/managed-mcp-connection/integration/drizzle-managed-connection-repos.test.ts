import { describe, expect } from "bun:test";
import { eq } from "drizzle-orm";
import { createUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import {
  ManagedConnectionEntity,
  type ManagedConnectionEntity as ManagedConnection,
} from "@/connections/managed-mcp-connection/domain/managed-connection-entity";
import { ManagedOAuthGrantEntity } from "@/connections/managed-mcp-connection/domain/managed-oauth-grant-entity";
import { ManagedOAuthAttemptEntity } from "@/connections/managed-mcp-connection/domain/managed-oauth-attempt-entity";
import { DrizzleManagedConnectionRepo } from "@/connections/managed-mcp-connection/infra/drizzle-managed-connection-repo";
import { DrizzleManagedOAuthAttemptRepo } from "@/connections/managed-mcp-connection/infra/drizzle-managed-oauth-attempt-repo";
import { DrizzleManagedOAuthGrantRepo } from "@/connections/managed-mcp-connection/infra/drizzle-managed-oauth-grant-repo";
import { DrizzleProjectRepo } from "@/projects/project/infra/drizzle-project-repo";
import { getDb } from "@/lib/db";
import { CoreError } from "@/lib/errors";
import {
  managedMcpConnections,
  managedOAuthGrants,
  managedOAuthAttempts,
  projects,
} from "@/lib/db/schema";
import { concurrentTest } from "tests/utils";
import { managedConnectionDefinitionFromPreset } from "@/connections/managed-mcp-connection/infra/managed-connection-presets";

const NOTION_CONNECTION = managedConnectionDefinitionFromPreset("notion");

const NOW = new Date("2026-11-17T12:00:00.000Z");

const ciphertext = () => ({
  ciphertext: Buffer.from("ciphertext"),
  iv: Buffer.from("iv"),
  authTag: Buffer.from("tag"),
  keyVersion: 1,
});

/**
 * The connection and grant tables reference each other: the connection's
 * active/candidate grant pointers are NO ACTION, and a grant cascades from
 * its connection. These cases pin the write order the use cases rely on and
 * that deleting the project removes both.
 */
describe("drizzle managed connection repos: circular foreign keys", () => {
  const connectionRepo = new DrizzleManagedConnectionRepo();
  const grantRepo = new DrizzleManagedOAuthGrantRepo();
  const createProject = async (): Promise<UuidV7> => {
    const projectId = createUuidV7();
    await getDb()
      .insert(projects)
      .values({
        id: projectId,
        name: "Managed connection repo project",
        slug: `managed-connection-repo-${crypto.randomUUID()}`,
        gitUrl: "https://github.com/example/test-project.git",
        createdByUserId: createUuidV7(),
        orgId: createUuidV7(),
      });
    return projectId;
  };

  const newGrant = (connection: ManagedConnection) =>
    ManagedOAuthGrantEntity.create({
      id: createUuidV7(),
      connectionId: connection.id,
      projectId: connection.projectId,
      clientId: "https://scarn.test/api/oauth/mcp/client-metadata.json",
      issuer: "https://mcp.notion.com",
      resource: "https://mcp.notion.com/mcp",
      credentialVersion: 1,
      encryptedCredentials: ciphertext(),
      encryptedIdentity: ciphertext(),
      grantedScopes: ["default"],
      authorizedAt: NOW,
      createdByUserId: createUuidV7(),
    });

  /** Inserts a connection, then its candidate grant, then points the connection at it. */
  const connectWithCandidate = async () => {
    const projectId = await createProject();
    const connecting = ManagedConnectionEntity.create({
      projectId,
      ...NOTION_CONNECTION,
      now: NOW,
    }).startConnect(NOW);
    await connectionRepo.insert(connecting);
    const grant = newGrant(connecting);
    await grantRepo.insert(grant);
    const awaiting = connecting.attachCandidate(grant.id, NOW);
    expect(
      await connectionRepo.saveIfVersion(awaiting, connecting.version),
    ).toBe(true);
    return { projectId, connection: awaiting, grant };
  };

  concurrentTest(
    "a confirmed grant is stored and reloads as the active grant",
    async () => {
      const { projectId, connection, grant } = await connectWithCandidate();
      const ready = connection.confirmCandidate(grant.id, "fp", {
        candidateFingerprint: "fp",
        confirmedByUserId: createUuidV7(),
        now: NOW,
      });
      expect(
        await connectionRepo.saveIfVersion(ready, connection.version),
      ).toBe(true);

      const reloaded = await connectionRepo.findById(projectId, connection.id);
      expect(reloaded?.state).toBe("ready");
      expect(reloaded?.servingGrantId).toBe(grant.id);
    },
  );

  concurrentTest(
    "a grant still pointed at can't be deleted until the pointer is cleared",
    async () => {
      const { projectId, connection, grant } = await connectWithCandidate();

      expect(
        await grantRepo.delete(projectId, connection.id, grant.id).then(
          () => "deleted",
          () => "rejected",
        ),
      ).toBe("rejected");

      const cancelled = connection.cancelCandidate(grant.id, NOW);
      expect(
        await connectionRepo.saveIfVersion(cancelled, connection.version),
      ).toBe(true);
      expect(await grantRepo.delete(projectId, connection.id, grant.id)).toBe(
        true,
      );
      expect(
        await grantRepo.findById(projectId, connection.id, grant.id),
      ).toBeNull();
    },
  );

  concurrentTest(
    "deleting the project removes its connection and grants",
    async () => {
      const { projectId, connection, grant } = await connectWithCandidate();

      await getDb().delete(projects).where(eq(projects.id, projectId));

      expect(
        await getDb()
          .select()
          .from(managedMcpConnections)
          .where(eq(managedMcpConnections.id, connection.id)),
      ).toEqual([]);
      expect(
        await getDb()
          .select()
          .from(managedOAuthGrants)
          .where(eq(managedOAuthGrants.id, grant.id)),
      ).toEqual([]);
    },
  );

  concurrentTest(
    "a connection's name, label, preset and server round-trip and load by name or resource",
    async () => {
      const projectId = await createProject();
      const connection = ManagedConnectionEntity.create({
        projectId,
        name: "acme-docs",
        label: "Acme docs",
        preset: null,
        server: {
          resource: "https://mcp.acme.test/mcp",
          issuerOrigin: "https://auth.acme.test",
          clientRegistration: "dcr",
        },
        now: NOW,
      });
      await connectionRepo.insert(connection);

      const byName = await connectionRepo.loadByName(projectId, "acme-docs");
      expect(byName?.toJSON()).toEqual(connection.toJSON());
      const byResource = await connectionRepo.loadByResource(
        projectId,
        "https://mcp.acme.test/mcp",
      );
      expect(byResource?.id).toBe(connection.id);
      expect(await connectionRepo.loadByName(projectId, "notion")).toBeNull();
    },
  );

  concurrentTest(
    "a project can't have two connections with the same name or MCP URL",
    async () => {
      const projectId = await createProject();
      await connectionRepo.insert(
        ManagedConnectionEntity.create({
          ...NOTION_CONNECTION,
          projectId,
          now: NOW,
        }),
      );
      const insert = async (
        overrides: Partial<
          Parameters<typeof ManagedConnectionEntity.create>[0]
        >,
      ) => {
        try {
          await connectionRepo.insert(
            ManagedConnectionEntity.create({
              ...NOTION_CONNECTION,
              projectId,
              now: NOW,
              ...overrides,
            }),
          );
          return null;
        } catch (error) {
          if (error instanceof CoreError) return error.code;
          throw error;
        }
      };

      expect(
        await insert({
          server: {
            ...NOTION_CONNECTION.server,
            resource: "https://mcp.other.test/mcp",
          },
        }),
      ).toBe("MANAGED_CONNECTION_EXISTS");
      expect(await insert({ name: "notion-two" })).toBe(
        "MANAGED_CONNECTION_EXISTS",
      );

      const otherProject = await createProject();
      await connectionRepo.insert(
        ManagedConnectionEntity.create({
          ...NOTION_CONNECTION,
          projectId: otherProject,
          now: NOW,
        }),
      );
    },
  );

  concurrentTest(
    "a refresh claim is stored and reloads with the grant",
    async () => {
      const { projectId, connection, grant } = await connectWithCandidate();
      const claimId = createUuidV7();
      await grantRepo.save(grant.claimRefresh(claimId, NOW));

      const reloaded = await grantRepo.findById(
        projectId,
        connection.id,
        grant.id,
      );
      expect(reloaded?.refreshClaim).toEqual({ claimId, claimedAt: NOW });
    },
  );

  concurrentTest(
    "saveIfClaim writes only with the matching claim and credential version",
    async () => {
      const { projectId, connection, grant } = await connectWithCandidate();
      const claimId = createUuidV7();
      const claimed = grant.claimRefresh(claimId, NOW);
      await grantRepo.save(claimed);
      const refreshed = {
        ...ciphertext(),
        ciphertext: Buffer.from("refreshed"),
      };
      const completed = claimed.completeRefresh(claimId, refreshed, NOW);

      expect(await grantRepo.saveIfClaim(completed, createUuidV7(), 1)).toBe(
        false,
      );
      expect(await grantRepo.saveIfClaim(completed, claimId, 2)).toBe(false);
      const untouched = await grantRepo.findById(
        projectId,
        connection.id,
        grant.id,
      );
      expect(untouched?.credentialVersion).toBe(1);
      expect(untouched?.refreshClaim?.claimId).toBe(claimId);

      expect(await grantRepo.saveIfClaim(completed, claimId, 1)).toBe(true);
      const stored = await grantRepo.findById(
        projectId,
        connection.id,
        grant.id,
      );
      expect(stored?.credentialVersion).toBe(2);
      expect(stored?.refreshClaim).toBeNull();
      expect(
        stored?.credentials.status === "live" &&
          stored.credentials.encryptedCredentials.ciphertext.toString(),
      ).toBe("refreshed");

      expect(await grantRepo.saveIfClaim(completed, claimId, 1)).toBe(false);
    },
  );

  concurrentTest("saveIfClaim writes nothing to a retired grant", async () => {
    const { projectId, connection, grant } = await connectWithCandidate();
    const claimId = createUuidV7();
    const claimed = grant.claimRefresh(claimId, NOW);
    await grantRepo.save(claimed.retire(NOW));

    const completed = claimed.completeRefresh(claimId, ciphertext(), NOW);
    expect(await grantRepo.saveIfClaim(completed, claimId, 1)).toBe(false);
    const stored = await grantRepo.findById(projectId, connection.id, grant.id);
    expect(stored?.isRetired).toBe(true);
  });

  concurrentTest(
    "cancelled pending and exchanging attempts lose PKCE without changing another actor's attempt",
    async () => {
      const { projectId, connection } = await connectWithCandidate();
      const attemptRepo = new DrizzleManagedOAuthAttemptRepo();
      const actorId = createUuidV7();
      const makeAttempt = (actorUserId: UuidV7) =>
        ManagedOAuthAttemptEntity.create({
          id: createUuidV7(),
          connectionId: connection.id,
          projectId,
          kind: "connect",
          expectedGeneration: connection.generation,
          actorUserId,
          binding: { kind: "browser", sessionDigest: crypto.randomUUID() },
          stateDigest: crypto.randomUUID(),
          clientId: "https://scarn.test/client",
          redirectUri: "https://scarn.test/callback",
          requestedScopes: ["default"],
          encryptedPkceVerifier: ciphertext(),
          now: NOW,
        });
      const pending = makeAttempt(actorId);
      const exchanging = makeAttempt(actorId).beginExchange(NOW);
      const other = makeAttempt(createUuidV7());
      for (const attempt of [pending, exchanging, other]) {
        await attemptRepo.insert(attempt);
      }

      await getDb().transaction(async (tx) => {
        expect(
          await new DrizzleProjectRepo().loadForUpdate(projectId, tx),
        ).not.toBeNull();
        await connectionRepo.loadForUpdate(projectId, connection.id, tx);
        for (const attempt of await attemptRepo.listOpenByConnection(
          projectId,
          connection.id,
          tx,
        )) {
          if (attempt.actorUserId !== actorId) continue;
          expect(
            await attemptRepo.saveIfStatus(
              attempt.cancel(NOW),
              attempt.status,
              tx,
            ),
          ).toBe(true);
        }
      });

      for (const attempt of [pending, exchanging]) {
        const stored = await attemptRepo.findByStateDigest(attempt.stateDigest);
        expect(stored?.progress).toEqual({ status: "cancelled" });
        expect(() => stored?.beginExchange(NOW)).toThrow();
        const [row] = await getDb()
          .select()
          .from(managedOAuthAttempts)
          .where(eq(managedOAuthAttempts.id, attempt.id));
        expect(row?.pkceVerifierCiphertext).toBeNull();
        expect(row?.pkceVerifierIv).toBeNull();
        expect(row?.pkceVerifierAuthTag).toBeNull();
        expect(row?.pkceVerifierKeyVersion).toBeNull();
      }
      expect(
        (await attemptRepo.findByStateDigest(other.stateDigest))?.progress,
      ).toEqual(other.progress);
    },
  );

  concurrentTest(
    "dropping a reconnect candidate deletes its ciphertext but preserves the confirmed grant and generation",
    async () => {
      const { projectId, connection, grant } = await connectWithCandidate();
      const ready = connection.confirmCandidate(grant.id, "fp", {
        candidateFingerprint: "fp",
        confirmedByUserId: createUuidV7(),
        now: NOW,
      });
      expect(
        await connectionRepo.saveIfVersion(ready, connection.version),
      ).toBe(true);
      const candidate = newGrant(ready);
      await grantRepo.insert(candidate);
      const reconnecting = ready.attachCandidate(candidate.id, NOW);
      expect(
        await connectionRepo.saveIfVersion(reconnecting, ready.version),
      ).toBe(true);
      await getDb().transaction(async (tx) => {
        await new DrizzleProjectRepo().loadForUpdate(projectId, tx);
        const locked = await connectionRepo.loadForUpdate(
          projectId,
          connection.id,
          tx,
        );
        if (!locked) throw new Error("Missing connection");
        expect(
          await connectionRepo.saveIfVersion(
            locked.cancelCandidate(candidate.id, NOW),
            locked.version,
            tx,
          ),
        ).toBe(true);
        expect(
          await grantRepo.delete(projectId, connection.id, candidate.id, tx),
        ).toBe(true);
      });
      const stored = await connectionRepo.findById(projectId, connection.id);
      expect(stored?.state).toBe("ready");
      expect(stored?.servingGrantId).toBe(grant.id);
      expect(stored?.generation).toBe(ready.generation);
      expect(
        (
          await grantRepo.findById(projectId, connection.id, grant.id)
        )?.toJSON(),
      ).toEqual(grant.toJSON());
      expect(
        await grantRepo.findById(projectId, connection.id, candidate.id),
      ).toBeNull();
    },
  );
});
