import { afterEach, describe, expect } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { ManagedConnectionEntity } from "@/connections/managed-mcp-connection/domain/managed-connection-entity";
import { DrizzleManagedConnectionRepo } from "@/connections/managed-mcp-connection/infra/drizzle-managed-connection-repo";
import { DrizzleManagedLaunchRepo } from "@/connections/managed-mcp-connection/infra/drizzle-managed-launch-repo";
import { createUuidV7 } from "@/common/contracts/uuid-v7";
import { getDb } from "@/lib/db";
import {
  managedMcpLaunchConnections,
  managedMcpOperations,
  projects,
} from "@/lib/db/schema";
import { serialTest } from "tests/utils";
import { seedMaintenanceLaunch } from "./managed-launch-maintenance-test-support";
import { managedConnectionDefinitionFromPreset } from "@/connections/managed-mcp-connection/infra/managed-connection-presets";

const NOTION_CONNECTION = managedConnectionDefinitionFromPreset("notion");

const NOW = new Date(Date.now() - 400 * 86_400_000);
const CUTOFF = new Date(NOW.getTime() - 30 * 86_400_000);
const OLD = new Date(CUTOFF.getTime() - 1);
const FUTURE = new Date(NOW.getTime() + 60_000);

describe("managed launch retention persistence", () => {
  const repo = new DrizzleManagedLaunchRepo();
  const projectIds: string[] = [];

  const seed = async () => {
    const projectId = createUuidV7();
    projectIds.push(projectId);
    await getDb()
      .insert(projects)
      .values({
        id: projectId,
        name: "Launch maintenance",
        slug: `maintenance-${projectId}`,
        gitUrl: "https://github.com/example/maintenance",
        createdByUserId: createUuidV7(),
        orgId: createUuidV7(),
      });
    const connection = ManagedConnectionEntity.create({
      projectId,
      ...NOTION_CONNECTION,
      now: NOW,
    });
    await new DrizzleManagedConnectionRepo().insert(connection);
    return {
      projectId,
      connectionId: connection.id,
      now: NOW,
      operationDeadlineAt: OLD,
    };
  };

  const launchRow = async (id: string) =>
    (
      await getDb()
        .select()
        .from(managedMcpLaunchConnections)
        .where(eq(managedMcpLaunchConnections.id, id))
    )[0];

  const operationRows = async (ids: string[]) =>
    await getDb()
      .select()
      .from(managedMcpOperations)
      .where(inArray(managedMcpOperations.id, ids));

  afterEach(async () => {
    await getDb().delete(projects).where(inArray(projects.id, projectIds));
    projectIds.length = 0;
  });

  serialTest(
    "skips locked launch rows so maintenance never waits behind operation admission",
    async () => {
      const base = await seed();
      const launch = await seedMaintenanceLaunch({
        ...base,
        status: "succeeded",
        completedAt: OLD,
      });
      await getDb().transaction(async (tx) => {
        await tx
          .select()
          .from(managedMcpLaunchConnections)
          .where(eq(managedMcpLaunchConnections.id, launch.launchId))
          .for("update");
        expect(await repo.closeTerminalLaunches({ now: NOW, limit: 100 })).toBe(
          0,
        );
      });
      expect(await repo.closeTerminalLaunches({ now: NOW, limit: 100 })).toBe(
        1,
      );
      await getDb().transaction(async (tx) => {
        await tx
          .select()
          .from(managedMcpLaunchConnections)
          .where(eq(managedMcpLaunchConnections.id, launch.launchId))
          .for("update");
        expect(
          await repo.deleteEndedRunLaunchesBefore({
            endedBefore: CUTOFF,
            limit: 100,
          }),
        ).toBe(0);
      });
      expect(
        await repo.deleteEndedRunLaunchesBefore({
          endedBefore: CUTOFF,
          limit: 100,
        }),
      ).toBe(1);
      expect(await operationRows([launch.operationId])).toEqual([]);
    },
  );

  serialTest(
    "closes all terminal statuses and effective expiry, not live or queued runs",
    async () => {
      const base = await seed();
      const terminal = await Promise.all(
        (
          [
            "succeeded",
            "failed",
            "timeout",
            "abandoned",
            "cancelled",
            "skipped",
            "yielded",
          ] as const
        ).map(
          async (status) => await seedMaintenanceLaunch({ ...base, status }),
        ),
      );
      const expired = await Promise.all([
        seedMaintenanceLaunch({
          ...base,
          status: "running",
          leaseExpiresAt: NOW,
          executionDeadlineAt: FUTURE,
        }),
        seedMaintenanceLaunch({
          ...base,
          status: "running",
          leaseExpiresAt: FUTURE,
          executionDeadlineAt: NOW,
        }),
      ]);
      const untouched = await Promise.all([
        seedMaintenanceLaunch({
          ...base,
          status: "running",
          leaseExpiresAt: FUTURE,
          executionDeadlineAt: FUTURE,
        }),
        seedMaintenanceLaunch({ ...base, status: "running" }),
        seedMaintenanceLaunch({
          ...base,
          status: "pending",
          leaseExpiresAt: OLD,
        }),
        seedMaintenanceLaunch({
          ...base,
          status: "queued",
          executionDeadlineAt: OLD,
        }),
      ]);
      for (let i = 0; i < terminal.length + expired.length; i++) {
        expect(await repo.closeTerminalLaunches({ now: NOW, limit: 1 })).toBe(
          1,
        );
      }
      expect(await repo.closeTerminalLaunches({ now: NOW, limit: 1 })).toBe(0);
      for (const row of [...terminal, ...expired]) {
        expect(await launchRow(row.launchId)).toMatchObject({
          state: "closed",
          closedAt: NOW,
        });
      }
      for (const row of untouched) {
        expect((await launchRow(row.launchId))?.state).toBe("open");
      }
      expect(
        await operationRows(
          [...terminal, ...expired, ...untouched].map((row) => row.operationId),
        ),
      ).toHaveLength(terminal.length + expired.length + untouched.length);
      expect(
        await repo.deleteEndedRunLaunchesBefore({
          endedBefore: CUTOFF,
          limit: 100,
        }),
      ).toBe(0);
    },
  );

  serialTest(
    "deletes only closed launches with recorded terminal ends strictly before cutoff and cascades operations in bounded batches",
    async () => {
      const base = await seed();
      const deleted = await Promise.all([
        seedMaintenanceLaunch({
          ...base,
          status: "succeeded",
          completedAt: OLD,
          state: "closed",
        }),
        seedMaintenanceLaunch({
          ...base,
          status: "yielded",
          completedAt: OLD,
          state: "closed",
        }),
      ]);
      const retained = await Promise.all([
        seedMaintenanceLaunch({
          ...base,
          status: "failed",
          completedAt: CUTOFF,
          state: "closed",
          createdAt: OLD,
          closedAt: OLD,
        }),
        seedMaintenanceLaunch({
          ...base,
          status: "cancelled",
          completedAt: NOW,
          state: "closed",
          createdAt: OLD,
          closedAt: OLD,
        }),
        seedMaintenanceLaunch({
          ...base,
          status: "succeeded",
          completedAt: OLD,
        }),
        seedMaintenanceLaunch({
          ...base,
          status: "abandoned",
          state: "closed",
          createdAt: OLD,
          closedAt: OLD,
        }),
        seedMaintenanceLaunch({
          ...base,
          status: "running",
          leaseExpiresAt: OLD,
          state: "closed",
          createdAt: OLD,
          closedAt: OLD,
        }),
        seedMaintenanceLaunch({
          ...base,
          status: "running",
          leaseExpiresAt: FUTURE,
          executionDeadlineAt: FUTURE,
          state: "closed",
          createdAt: OLD,
          closedAt: OLD,
        }),
        seedMaintenanceLaunch({
          ...base,
          status: "running",
          completedAt: OLD,
          leaseExpiresAt: FUTURE,
          state: "closed",
        }),
      ]);
      expect(
        await repo.deleteEndedRunLaunchesBefore({
          endedBefore: CUTOFF,
          limit: 1,
        }),
      ).toBe(1);
      expect(
        await operationRows(deleted.map((row) => row.operationId)),
      ).toHaveLength(1);
      expect(
        await repo.deleteEndedRunLaunchesBefore({
          endedBefore: CUTOFF,
          limit: 1,
        }),
      ).toBe(1);
      expect(
        await repo.deleteEndedRunLaunchesBefore({
          endedBefore: CUTOFF,
          limit: 1,
        }),
      ).toBe(0);
      expect(
        await operationRows(deleted.map((row) => row.operationId)),
      ).toEqual([]);
      for (const row of deleted)
        expect(await launchRow(row.launchId)).toBeUndefined();
      for (const row of retained)
        expect(await launchRow(row.launchId)).toBeDefined();
      expect(
        await operationRows(retained.map((row) => row.operationId)),
      ).toHaveLength(retained.length);
    },
  );
});
