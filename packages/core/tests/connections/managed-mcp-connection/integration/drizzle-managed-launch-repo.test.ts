import { describe, expect } from "bun:test";
import { createUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import {
  ManagedConnectionEntity,
  type ServingManagedConnectionEntity,
} from "@/connections/managed-mcp-connection/domain/managed-connection-entity";
import {
  createManagedOperation,
  MANAGED_LAUNCH_MAX_OPEN_OPERATIONS,
  ManagedLaunchConnectionEntity,
} from "@/connections/managed-mcp-connection/domain/managed-launch-connection-entity";
import {
  launchClaimTokenDigest,
  mcpSessionIdDigest,
  randomRelayCapability,
  relayCapabilityDigest,
} from "@/connections/managed-mcp-connection/domain/managed-launch-digests";
import { ManagedOAuthGrantEntity } from "@/connections/managed-mcp-connection/domain/managed-oauth-grant-entity";
import { DrizzleManagedConnectionRepo } from "@/connections/managed-mcp-connection/infra/drizzle-managed-connection-repo";
import { DrizzleManagedLaunchRepo } from "@/connections/managed-mcp-connection/infra/drizzle-managed-launch-repo";
import { DrizzleManagedOAuthGrantRepo } from "@/connections/managed-mcp-connection/infra/drizzle-managed-oauth-grant-repo";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { concurrentTest } from "tests/utils";
import { managedConnectionDefinitionFromPreset } from "@/connections/managed-mcp-connection/infra/managed-connection-presets";

const NOTION_CONNECTION = managedConnectionDefinitionFromPreset("notion");

const NOW = new Date("2026-11-18T12:00:00.000Z");
const DEADLINE = new Date("2026-11-18T12:04:05.000Z");

const ciphertext = () => ({
  ciphertext: Buffer.from("ciphertext"),
  iv: Buffer.from("iv"),
  authTag: Buffer.from("tag"),
  keyVersion: 1,
});

const insertProject = async (): Promise<UuidV7> => {
  const projectId = createUuidV7();
  await getDb().execute(sql`
    INSERT INTO "app"."projects"
      ("id", "name", "slug", "git_url", "created_by_user_id", "org_id")
    VALUES
      (${projectId}, 'Managed launch repo project',
       ${`managed-launch-repo-${projectId}`},
       'https://github.com/example/managed-launch.git',
       ${createUuidV7()}, ${createUuidV7()})
  `);
  return projectId;
};

const insertTaskRun = async (projectId: UuidV7): Promise<UuidV7> => {
  const workItemId = createUuidV7();
  const taskId = createUuidV7();
  const taskRunId = createUuidV7();
  await getDb().execute(sql`
    INSERT INTO "app"."work_items"
      ("id", "project_id", "platform", "platform_key", "title")
    VALUES
      (${workItemId}, ${projectId}, 'github', ${`issue-${workItemId}`},
       'Managed launch item')
  `);
  await getDb().execute(sql`
    INSERT INTO "app"."tasks"
      ("id", "project_id", "work_item_id", "kind", "prompt", "status",
       "schema_version")
    VALUES
      (${taskId}, ${projectId}, ${workItemId}, 'agent', 'Do the thing',
       'queued', 1)
  `);
  await getDb().execute(sql`
    INSERT INTO "app"."task_runs"
      ("id", "task_id", "project_id", "work_item_id", "number", "reason",
       "status")
    VALUES
      (${taskRunId}, ${taskId}, ${projectId}, ${workItemId}, 1, 'initial',
       'pending')
  `);
  return taskRunId;
};

describe("DrizzleManagedLaunchRepo", () => {
  const connectionRepo = new DrizzleManagedConnectionRepo();
  const grantRepo = new DrizzleManagedOAuthGrantRepo();
  const repo = new DrizzleManagedLaunchRepo();

  /** A project with a ready Notion connection and one run. */
  const seed = async () => {
    const projectId = await insertProject();
    const taskRunId = await insertTaskRun(projectId);
    const connecting = ManagedConnectionEntity.create({
      projectId,
      ...NOTION_CONNECTION,
      now: NOW,
    }).startConnect(NOW);
    await connectionRepo.insert(connecting);
    const grant = ManagedOAuthGrantEntity.create({
      id: createUuidV7(),
      connectionId: connecting.id,
      projectId,
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
    await grantRepo.insert(grant);
    const awaiting = connecting.attachCandidate(grant.id, NOW);
    await connectionRepo.saveIfVersion(awaiting, connecting.version);
    const ready = awaiting.confirmCandidate(grant.id, "fp", {
      candidateFingerprint: "fp",
      confirmedByUserId: createUuidV7(),
      now: NOW,
    });
    await connectionRepo.saveIfVersion(ready, awaiting.version);
    return {
      projectId,
      taskRunId,
      connection: ready as ServingManagedConnectionEntity,
    };
  };

  const newLaunch = (
    seeded: Awaited<ReturnType<typeof seed>>,
    entryKey = "notion",
    claimToken = "claim-a",
  ) => {
    const capability = randomRelayCapability();
    return {
      capability,
      launch: ManagedLaunchConnectionEntity.create({
        projectId: seeded.projectId,
        taskRunId: seeded.taskRunId,
        claimTokenDigest: launchClaimTokenDigest(claimToken),
        entryKey,
        connection: seeded.connection,
        capabilityDigest: relayCapabilityDigest(capability),
        now: NOW,
      }),
    };
  };

  const newOperation = (launchConnectionId: UuidV7) =>
    createManagedOperation({
      launchConnectionId,
      startedAt: NOW,
      deadlineAt: DEADLINE,
    });

  const countOpenRuns = (seeded: Awaited<ReturnType<typeof seed>>) =>
    repo.countOpenRunsForConnection(seeded.projectId, seeded.connection.id);

  concurrentTest(
    "an upserted launch loads by capability digest and lists as open",
    async () => {
      const seeded = await seed();
      const { capability, launch } = newLaunch(seeded);
      const stored = await repo.upsertOpen(launch, getDb());
      expect(stored.toJSON()).toEqual(launch.toJSON());

      const loaded = await repo.loadByCapabilityDigest(
        relayCapabilityDigest(capability),
      );
      expect(loaded?.toJSON()).toEqual(launch.toJSON());
      expect(loaded?.isAuthorizedBy(seeded.connection)).toBe(true);
      expect(
        await repo.loadByCapabilityDigest(
          relayCapabilityDigest(randomRelayCapability()),
        ),
      ).toBeNull();
      expect(
        (await repo.listOpenForRun(seeded.taskRunId, getDb())).map(
          (row) => row.id,
        ),
      ).toEqual([launch.id]);
    },
  );

  concurrentTest(
    "counts distinct open runs per connection across entries and claims",
    async () => {
      const seeded = await seed();
      expect(await countOpenRuns(seeded)).toBe(0);

      await repo.upsertOpen(newLaunch(seeded, "notion").launch, getDb());
      await repo.upsertOpen(newLaunch(seeded, "notion-2").launch, getDb());
      await repo.upsertOpen(
        newLaunch(seeded, "notion", "claim-b").launch,
        getDb(),
      );
      expect(await countOpenRuns(seeded)).toBe(1);

      const secondRun = {
        ...seeded,
        taskRunId: await insertTaskRun(seeded.projectId),
      };
      await repo.upsertOpen(newLaunch(secondRun).launch, getDb());
      expect(
        await getDb().transaction((tx) =>
          repo.countOpenRunsForConnection(
            seeded.projectId,
            seeded.connection.id,
            tx,
          ),
        ),
      ).toBe(2);
    },
  );

  concurrentTest("closed launch rows do not count as open runs", async () => {
    const seeded = await seed();
    const secondRun = {
      ...seeded,
      taskRunId: await insertTaskRun(seeded.projectId),
    };
    await repo.upsertOpen(newLaunch(seeded).launch, getDb());
    await repo.upsertOpen(newLaunch(secondRun).launch, getDb());
    await repo.closeAllForRun(seeded.taskRunId, NOW, getDb());
    expect(await countOpenRuns(seeded)).toBe(1);

    await repo.closeAllForRun(secondRun.taskRunId, NOW, getDb());
    expect(await countOpenRuns(seeded)).toBe(0);
  });

  concurrentTest(
    "open run counts are scoped to both project and connection",
    async () => {
      const seeded = await seed();
      const other = await seed();
      await repo.upsertOpen(newLaunch(seeded).launch, getDb());
      await repo.upsertOpen(newLaunch(other).launch, getDb());

      expect(await countOpenRuns(seeded)).toBe(1);
      expect(await countOpenRuns(other)).toBe(1);
      expect(
        await repo.countOpenRunsForConnection(
          other.projectId,
          seeded.connection.id,
        ),
      ).toBe(0);
      expect(
        await repo.countOpenRunsForConnection(
          seeded.projectId,
          other.connection.id,
        ),
      ).toBe(0);
    },
  );

  concurrentTest(
    "re-registering under the same claim rotates the capability and keeps the row",
    async () => {
      const seeded = await seed();
      const first = newLaunch(seeded);
      await repo.upsertOpen(first.launch, getDb());
      await repo.saveSessionBinding(
        first.launch.bindSession(mcpSessionIdDigest("session-1")),
      );

      const second = newLaunch(seeded);
      const stored = await repo.upsertOpen(second.launch, getDb());

      expect(stored.id).toBe(first.launch.id);
      expect(stored.capabilityDigest).toEqual(second.launch.capabilityDigest);
      expect(stored.mcpSessionIdDigest).toBeNull();
      expect(
        await repo.loadByCapabilityDigest(
          relayCapabilityDigest(first.capability),
        ),
      ).toBeNull();
    },
  );

  concurrentTest(
    "a later session binding replaces the earlier one, and only while open",
    async () => {
      const seeded = await seed();
      const { capability, launch } = newLaunch(seeded);
      await repo.upsertOpen(launch, getDb());
      const second = mcpSessionIdDigest("session-2");
      expect(
        await repo.saveSessionBinding(
          launch.bindSession(mcpSessionIdDigest("session-1")),
        ),
      ).toBe(true);
      expect(await repo.saveSessionBinding(launch.bindSession(second))).toBe(
        true,
      );
      await repo.closeAllForRun(seeded.taskRunId, NOW, getDb());
      expect(
        await repo.saveSessionBinding(
          launch.bindSession(mcpSessionIdDigest("session-3")),
        ),
      ).toBe(false);
      const loaded = await repo.loadByCapabilityDigest(
        relayCapabilityDigest(capability),
      );
      expect(loaded?.mcpSessionIdDigest).toEqual(second);
    },
  );

  concurrentTest(
    "operations are capped per launch connection, and a deleted one frees a slot",
    async () => {
      const seeded = await seed();
      const { launch } = newLaunch(seeded);
      await repo.upsertOpen(launch, getDb());
      const operations = Array.from(
        { length: MANAGED_LAUNCH_MAX_OPEN_OPERATIONS },
        () => newOperation(launch.id),
      );
      const admitted = await Promise.all(
        operations.map((operation) => repo.insertOperation(operation, getDb())),
      );
      expect(admitted.every(Boolean)).toBe(true);
      expect(await repo.insertOperation(newOperation(launch.id), getDb())).toBe(
        false,
      );

      const [first] = operations;
      if (!first) {
        throw new Error("Expected an operation");
      }
      await repo.deleteOperation(first.id);
      expect(await repo.insertOperation(newOperation(launch.id), getDb())).toBe(
        true,
      );
    },
  );

  concurrentTest("concurrent admissions never exceed the cap", async () => {
    const seeded = await seed();
    const { launch } = newLaunch(seeded);
    await repo.upsertOpen(launch, getDb());
    const admitted = await Promise.all(
      Array.from({ length: MANAGED_LAUNCH_MAX_OPEN_OPERATIONS + 4 }, () =>
        repo.insertOperation(newOperation(launch.id), getDb()),
      ),
    );
    expect(admitted.filter(Boolean)).toHaveLength(
      MANAGED_LAUNCH_MAX_OPEN_OPERATIONS,
    );
  });

  concurrentTest(
    "listOperations returns the run's operations across its launch connections",
    async () => {
      const seeded = await seed();
      const notion = newLaunch(seeded, "notion");
      const second = newLaunch(seeded, "notion-2");
      await repo.upsertOpen(notion.launch, getDb());
      await repo.upsertOpen(second.launch, getDb());
      const a = newOperation(notion.launch.id);
      const b = newOperation(second.launch.id);
      await repo.insertOperation(a, getDb());
      await repo.insertOperation(b, getDb());

      const listed = await repo.listOperations(seeded.taskRunId, getDb());
      expect(listed.map((operation) => operation.id).sort()).toEqual(
        [a.id, b.id].sort(),
      );
      expect(listed[0]).toMatchObject({
        connectionId: seeded.connection.id,
        startedAt: NOW,
        deadlineAt: DEADLINE,
      });
      expect(
        await repo.listOperations(
          await insertTaskRun(seeded.projectId),
          getDb(),
        ),
      ).toEqual([]);
    },
  );

  concurrentTest(
    "closeAllForRun closes every open row and blocks new operations",
    async () => {
      const seeded = await seed();
      const notion = newLaunch(seeded, "notion");
      const second = newLaunch(seeded, "notion-2");
      await repo.upsertOpen(notion.launch, getDb());
      await repo.upsertOpen(second.launch, getDb());

      expect(await repo.closeAllForRun(seeded.taskRunId, NOW, getDb())).toBe(2);
      expect(await repo.closeAllForRun(seeded.taskRunId, NOW, getDb())).toBe(0);
      expect(await repo.listOpenForRun(seeded.taskRunId, getDb())).toEqual([]);

      const closed = await repo.loadByCapabilityDigest(
        relayCapabilityDigest(notion.capability),
      );
      expect(closed?.state).toBe("closed");
      expect(closed?.closedAt).toEqual(NOW);
      expect(closed?.isAuthorizedBy(seeded.connection)).toBe(false);
      expect(
        await repo.insertOperation(newOperation(notion.launch.id), getDb()),
      ).toBe(false);
    },
  );

  concurrentTest(
    "loadForShare reads the connection inside a transaction",
    async () => {
      const seeded = await seed();
      const loaded = await getDb().transaction((tx) =>
        connectionRepo.loadForShare(seeded.projectId, seeded.connection.id, tx),
      );
      expect(loaded?.toJSON()).toEqual(seeded.connection.toJSON());
      expect(
        await getDb().transaction((tx) =>
          connectionRepo.loadForShare(createUuidV7(), seeded.connection.id, tx),
        ),
      ).toBeNull();
    },
  );
});
