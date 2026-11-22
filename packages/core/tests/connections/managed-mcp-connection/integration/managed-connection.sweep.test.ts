import { afterAll, afterEach, beforeEach, describe, expect } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { MANAGED_CONNECTION_RETENTION_MS } from "@/connections/managed-mcp-connection/domain/managed-connection-lapse";
import { MANAGED_OAUTH_ATTEMPT_TTL_MS } from "@/connections/managed-mcp-connection/domain/managed-oauth-attempt-entity";
import { getDb } from "@/lib/db";
import {
  managedConnectionEvents,
  managedMcpConnections,
  managedMcpLaunchConnections,
  managedMcpOperations,
  managedOAuthAttempts,
  managedOAuthGrants,
} from "@/lib/db/schema";
import { serialTest, unwrapAsync } from "tests/utils";
import { createManagedConnectionHarness } from "./managed-connection-test-support";
import { seedMaintenanceLaunch } from "./managed-launch-maintenance-test-support";

const SECRET = "test-managed-connections-sweep-secret-0123";
const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * The sweep is global, and other files share the database. Every test here
 * runs on a clock a year in the past, so rows those files write in real time
 * are never lapsed or past retention for these sweeps.
 */
const PAST_OFFSET_MS = -400 * DAY_MS;

const connectionRowOf = async (connectionId: string) => {
  const [row] = await getDb()
    .select()
    .from(managedMcpConnections)
    .where(eq(managedMcpConnections.id, connectionId));
  return row;
};

const grantRowsOf = async (connectionId: string) =>
  await getDb()
    .select({
      id: managedOAuthGrants.id,
      credentialsCiphertext: managedOAuthGrants.credentialsCiphertext,
      retiredAt: managedOAuthGrants.retiredAt,
    })
    .from(managedOAuthGrants)
    .where(eq(managedOAuthGrants.connectionId, connectionId));

const attemptRowsOf = async (connectionId: string) =>
  await getDb()
    .select({
      status: managedOAuthAttempts.status,
      pkceVerifierCiphertext: managedOAuthAttempts.pkceVerifierCiphertext,
      candidateGrantId: managedOAuthAttempts.candidateGrantId,
    })
    .from(managedOAuthAttempts)
    .where(eq(managedOAuthAttempts.connectionId, connectionId));

const eventTypesOf = async (connectionId: string) =>
  (
    await getDb()
      .select({ type: managedConnectionEvents.type })
      .from(managedConnectionEvents)
      .where(eq(managedConnectionEvents.connectionId, connectionId))
  ).map((row) => row.type);

/**
 * `POST /api/internal/connections/sweep`: the daily, service-authenticated
 * cleanup of lapsed attempts and candidates and of retired grants and events
 * past their 30-day retention (decisions 7 and 11).
 */
describe("managed connection sweep", () => {
  const harness = createManagedConnectionHarness();
  const { fake, clock } = harness;

  const sweep = async (authorization = `Bearer ${SECRET}`) =>
    await harness.apiClient.api.internal.connections.sweep.post(undefined, {
      headers: { authorization },
    });

  const sweepOk = async () => await unwrapAsync(sweep());

  let originalSecret: string | undefined;
  beforeEach(() => {
    originalSecret = process.env["RECONCILE_CRON_SECRET"];
    process.env["RECONCILE_CRON_SECRET"] = SECRET;
    clock.advance(PAST_OFFSET_MS);
  });

  afterEach(() => {
    if (originalSecret === undefined) {
      delete process.env["RECONCILE_CRON_SECRET"];
    } else {
      process.env["RECONCILE_CRON_SECRET"] = originalSecret;
    }
    fake.reset();
    clock.reset();
  });

  afterAll(async () => {
    await fake.stop();
  });

  serialTest("rejects a request without the service token", async () => {
    const missing =
      await harness.apiClient.api.internal.connections.sweep.post();
    expect(missing.status).toBe(401);
    const wrong = await sweep("Bearer wrong");
    expect(wrong.status).toBe(401);
  });

  serialTest(
    "reads show a lapsed connect and candidate as expired before any sweep",
    async () => {
      const connecting = await harness.connectToCallback("sweep-read-attempt");
      const awaiting = await harness.connectToCandidate("sweep-read-candidate");
      const ready = await harness.connectToReady("sweep-read-reconnect");
      await harness.reconnectToCandidate(
        ready.owner,
        ready.projectId,
        ready.connectionId,
      );
      const reconnecting = await harness.getConnection(
        ready.owner,
        ready.projectId,
        ready.connectionId,
      );
      clock.advance(MANAGED_OAUTH_ATTEMPT_TTL_MS);

      const attemptView = await harness.getConnection(
        connecting.owner,
        connecting.projectId,
        connecting.connectionId,
      );
      expect(attemptView).toMatchObject({
        state: "disconnected",
        reasonCode: "attempt_expired",
        candidate: null,
      });
      const candidateView = await harness.getConnection(
        awaiting.owner,
        awaiting.projectId,
        awaiting.connectionId,
      );
      expect(candidateView).toMatchObject({
        state: "disconnected",
        reasonCode: "candidate_expired",
        version: awaiting.pending.version,
        candidate: null,
      });
      const listed = await unwrapAsync(
        harness
          .connections(ready.projectId)
          .get({ headers: ready.owner.authHeaders }),
      );
      expect(listed).toEqual([
        {
          ...reconnecting,
          state: "ready",
          candidate: null,
        },
      ]);

      expect((await connectionRowOf(connecting.connectionId))?.state).toBe(
        "connecting",
      );
      expect((await connectionRowOf(awaiting.connectionId))?.state).toBe(
        "awaiting_confirmation",
      );
      expect(await grantRowsOf(awaiting.connectionId)).toHaveLength(1);
    },
  );

  serialTest("expires a lapsed attempt and deletes its verifier", async () => {
    const { connectionId } = await harness.connectToCallback("sweep-attempt");
    expect(await attemptRowsOf(connectionId)).toEqual([
      {
        status: "pending",
        pkceVerifierCiphertext: expect.any(Buffer) as Buffer,
        candidateGrantId: null,
      },
    ]);

    clock.advance(MANAGED_OAUTH_ATTEMPT_TTL_MS - 60_000);
    await sweepOk();
    expect((await attemptRowsOf(connectionId))[0]?.status).toBe("pending");

    clock.advance(60_000);
    const result = await sweepOk();

    expect(result.attemptsExpired).toBeGreaterThanOrEqual(1);
    expect(await attemptRowsOf(connectionId)).toEqual([
      {
        status: "expired",
        pkceVerifierCiphertext: null,
        candidateGrantId: null,
      },
    ]);
    expect(await connectionRowOf(connectionId)).toMatchObject({
      state: "disconnected",
      reasonCode: "attempt_expired",
    });
  });

  serialTest(
    "expires a lapsed first-connect candidate and deletes its grant",
    async () => {
      const { connectionId, candidate } =
        await harness.connectToCandidate("sweep-candidate");
      clock.advance(MANAGED_OAUTH_ATTEMPT_TTL_MS);

      const result = await sweepOk();

      expect(result.candidatesExpired).toBeGreaterThanOrEqual(1);
      expect(await connectionRowOf(connectionId)).toMatchObject({
        state: "disconnected",
        reasonCode: "candidate_expired",
        candidateGrantId: null,
      });
      expect(await grantRowsOf(connectionId)).toEqual([]);
      expect(await attemptRowsOf(connectionId)).toEqual([
        {
          status: "succeeded",
          pkceVerifierCiphertext: null,
          candidateGrantId: null,
        },
      ]);
      expect(await eventTypesOf(connectionId)).toContain("candidate_expired");
      expect(candidate.id).not.toBeNull();
    },
  );

  serialTest(
    "expires a lapsed reconnect candidate and leaves the active grant serving",
    async () => {
      const { owner, projectId, connectionId, ready } =
        await harness.connectToReady("sweep-reconnect");
      const [active] = await grantRowsOf(connectionId);
      const { candidate } = await harness.reconnectToCandidate(
        owner,
        projectId,
        connectionId,
      );
      clock.advance(MANAGED_OAUTH_ATTEMPT_TTL_MS);

      const result = await sweepOk();

      expect(result.candidatesExpired).toBeGreaterThanOrEqual(1);
      expect(await connectionRowOf(connectionId)).toMatchObject({
        state: "ready",
        activeGrantId: active?.id,
        candidateGrantId: null,
        generation: ready.generation,
      });
      expect(await grantRowsOf(connectionId)).toEqual([
        {
          id: active?.id ?? "",
          credentialsCiphertext: expect.any(Buffer) as Buffer,
          retiredAt: null,
        },
      ]);
      expect(
        (await grantRowsOf(connectionId)).some(
          (grant) => grant.id === candidate.id,
        ),
      ).toBe(false);
    },
  );

  serialTest(
    "a new connect replaces a lapsed candidate the sweep hasn't reached",
    async () => {
      const { owner, projectId, connectionId } =
        await harness.connectToCandidate("sweep-restart");
      clock.advance(MANAGED_OAUTH_ATTEMPT_TTL_MS);

      const restarted = await harness.startConnect(owner, projectId);

      expect(restarted.connectionId).toBe(connectionId);
      expect(await grantRowsOf(connectionId)).toEqual([]);
      expect((await connectionRowOf(connectionId))?.state).toBe("connecting");
      expect(await eventTypesOf(connectionId)).toContain("candidate_expired");
    },
  );

  serialTest(
    "deletes retired grants and events after 30 days, not before",
    async () => {
      const { owner, projectId, connectionId } =
        await harness.connectToReady("sweep-retention");
      await harness.disconnect(owner, projectId, connectionId);
      const [retired] = await grantRowsOf(connectionId);
      expect(retired?.retiredAt).not.toBeNull();

      clock.advance(MANAGED_CONNECTION_RETENTION_MS - DAY_MS);
      await sweepOk();
      expect(await grantRowsOf(connectionId)).toHaveLength(1);
      expect((await eventTypesOf(connectionId)).length).toBeGreaterThan(0);

      clock.advance(2 * DAY_MS);
      const result = await sweepOk();

      expect(result.grantsDeleted).toBeGreaterThanOrEqual(1);
      expect(result.eventsDeleted).toBeGreaterThanOrEqual(1);
      expect(await grantRowsOf(connectionId)).toEqual([]);
      expect(await eventTypesOf(connectionId)).toEqual([]);
      expect(await connectionRowOf(connectionId)).toMatchObject({
        state: "disconnected",
      });
    },
  );

  serialTest(
    "closes terminal launches, retains live unknown operations, and cascades old ended launches once",
    async () => {
      const ready = await harness.connectToReady("sweep-launch-retention");
      const now = clock.now();
      const old = new Date(
        now.getTime() - MANAGED_CONNECTION_RETENTION_MS - DAY_MS,
      );
      const base = { ...ready, now };
      const terminal = await seedMaintenanceLaunch({
        ...base,
        status: "failed",
        completedAt: now,
      });
      const ended = await seedMaintenanceLaunch({
        ...base,
        status: "yielded",
        completedAt: old,
      });
      const live = await seedMaintenanceLaunch({
        ...base,
        status: "running",
        leaseExpiresAt: new Date(now.getTime() + DAY_MS),
        executionDeadlineAt: new Date(now.getTime() + DAY_MS),
        createdAt: old,
        operationDeadlineAt: old,
      });
      const first = await sweepOk();
      expect(first.launchesClosed).toBeGreaterThanOrEqual(2);
      expect(first.launchesDeleted).toBeGreaterThanOrEqual(1);
      const launches = await getDb()
        .select()
        .from(managedMcpLaunchConnections)
        .where(
          eq(managedMcpLaunchConnections.connectionId, ready.connectionId),
        );
      expect(launches.find((row) => row.id === terminal.launchId)?.state).toBe(
        "closed",
      );
      expect(launches.find((row) => row.id === live.launchId)?.state).toBe(
        "open",
      );
      expect(launches).toHaveLength(2);
      const operationIds = [
        terminal.operationId,
        ended.operationId,
        live.operationId,
      ];
      const operations = await getDb()
        .select()
        .from(managedMcpOperations)
        .where(inArray(managedMcpOperations.id, operationIds));
      expect(operations.some((row) => row.id === ended.operationId)).toBe(
        false,
      );
      expect(operations.some((row) => row.id === terminal.operationId)).toBe(
        true,
      );
      expect(operations.some((row) => row.id === live.operationId)).toBe(true);
      expect(await sweepOk()).toEqual({
        attemptsExpired: 0,
        candidatesExpired: 0,
        grantsDeleted: 0,
        eventsDeleted: 0,
        launchesClosed: 0,
        launchesDeleted: 0,
      });
      expect(
        await getDb()
          .select()
          .from(managedMcpLaunchConnections)
          .where(
            eq(managedMcpLaunchConnections.connectionId, ready.connectionId),
          ),
      ).toEqual(launches);
      expect(
        await getDb()
          .select()
          .from(managedMcpOperations)
          .where(inArray(managedMcpOperations.id, operationIds)),
      ).toEqual(operations);
    },
  );

  serialTest("a second run is a no-op", async () => {
    await harness.connectToCallback("sweep-idempotent-attempt");
    await harness.connectToCandidate("sweep-idempotent-candidate");
    const retention = await harness.connectToReady("sweep-idempotent-grant");
    await harness.disconnect(
      retention.owner,
      retention.projectId,
      retention.connectionId,
    );
    clock.advance(MANAGED_CONNECTION_RETENTION_MS + DAY_MS);

    const first = await sweepOk();
    const second = await sweepOk();

    expect(first.attemptsExpired).toBeGreaterThanOrEqual(1);
    expect(first.candidatesExpired).toBeGreaterThanOrEqual(1);
    expect(first.grantsDeleted).toBeGreaterThanOrEqual(1);
    expect(first.eventsDeleted).toBeGreaterThanOrEqual(1);
    expect(second).toEqual({
      attemptsExpired: 0,
      candidatesExpired: 0,
      grantsDeleted: 0,
      eventsDeleted: 0,
      launchesClosed: 0,
      launchesDeleted: 0,
    });
  });
});
