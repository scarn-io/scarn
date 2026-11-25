/**
 * `managed_mcp_connections.discovery` is a cache of what the probe found, so
 * a connection whose stored discovery can't be read still loads, with no
 * overrides, and the bad row is logged. Rows are written directly to stand in
 * for ones written by older code. See `docs/persistence/json-columns.md`.
 */
import { describe, expect } from "bun:test";
import { eq } from "drizzle-orm";
import { createUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import { ManagedConnectionEntity } from "@/connections/managed-mcp-connection/domain/managed-connection-entity";
import { DrizzleManagedConnectionRepo } from "@/connections/managed-mcp-connection/infra/drizzle-managed-connection-repo";
import { getDb } from "@/lib/db";
import { managedMcpConnections, projects } from "@/lib/db/schema";
import type { Logger } from "@scarn/observability/logging";
import { concurrentTest } from "tests/utils";
import discoveryFixtures from "../fixtures/discovery.json";

const NOW = new Date("2026-11-24T12:00:00.000Z");

const recordingLogger = () => {
  const errors: unknown[][] = [];
  const logger = {
    error: (...args: unknown[]) => errors.push(args),
  } as unknown as Logger;
  return { logger, errors };
};

const createProject = async (): Promise<UuidV7> => {
  const projectId = createUuidV7();
  await getDb()
    .insert(projects)
    .values({
      id: projectId,
      name: "Managed connection stored discovery",
      slug: `managed-connection-discovery-${crypto.randomUUID()}`,
      gitUrl: "https://github.com/example/test-project.git",
      createdByUserId: createUuidV7(),
      orgId: createUuidV7(),
    });
  return projectId;
};

const insertConnection = async (
  repo: DrizzleManagedConnectionRepo,
  projectId: UuidV7,
  discovery: object,
): Promise<UuidV7> => {
  const name = `custom-${crypto.randomUUID().slice(0, 8)}`;
  const connection = ManagedConnectionEntity.create({
    projectId,
    name,
    label: name,
    preset: null,
    server: {
      resource: `https://mcp.example.test/${name}`,
      issuerOrigin: "https://auth.example.test",
      clientRegistration: "dcr",
    },
    now: NOW,
  });
  await repo.insert(connection);
  await getDb()
    .update(managedMcpConnections)
    .set({ discovery })
    .where(eq(managedMcpConnections.id, connection.id));
  return connection.id;
};

describe("managed connection stored discovery", () => {
  for (const fixture of discoveryFixtures) {
    concurrentTest(`loads the ${fixture.name} fixture`, async () => {
      const repo = new DrizzleManagedConnectionRepo();
      const projectId = await createProject();
      const id = await insertConnection(repo, projectId, fixture.discovery);

      const loaded = await repo.findById(projectId, id);
      expect<object | undefined>(loaded?.server.discovery).toEqual(
        Object.keys(fixture.expected).length === 0
          ? undefined
          : fixture.expected,
      );
    });
  }

  concurrentTest(
    "an unreadable discovery loads with no overrides and is logged",
    async () => {
      const { logger, errors } = recordingLogger();
      const repo = new DrizzleManagedConnectionRepo(logger);
      const projectId = await createProject();
      const readable = await insertConnection(repo, projectId, {
        tokenErrors: "slack",
      });
      const unreadable = await insertConnection(repo, projectId, {
        endpointOrigins: "https://auth.example.test",
      });

      const listed = await repo.listByProject(projectId);
      expect(listed).toHaveLength(2);
      const discoveryOf = (id: string) =>
        listed.find((connection) => connection.id === id)?.server.discovery;
      expect(discoveryOf(readable)).toEqual({ tokenErrors: "slack" });
      expect(discoveryOf(unreadable)).toBeUndefined();

      const found = await repo.findById(projectId, unreadable);
      expect(found?.server.discovery).toBeUndefined();

      expect(errors).toHaveLength(2);
      expect(errors[0]?.[0]).toMatchObject({
        table: "managed_mcp_connections",
        projectId,
        connectionId: unreadable,
      });
    },
  );
});
