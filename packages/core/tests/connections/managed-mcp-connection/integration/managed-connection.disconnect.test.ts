import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createUuidV7 } from "@/common/contracts/uuid-v7";
import { getDb } from "@/lib/db";
import {
  managedConnectionEvents,
  managedOAuthAttempts,
  managedOAuthGrants,
} from "@/lib/db/schema";
import { MANAGED_CONNECTION_PRESETS } from "@/connections/managed-mcp-connection/infra/managed-connection-presets";
import { createManagedConnectionHarness } from "./managed-connection-test-support";

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
    })
    .from(managedOAuthAttempts)
    .where(eq(managedOAuthAttempts.connectionId, connectionId));

const eventsOf = async (connectionId: string) =>
  await getDb()
    .select()
    .from(managedConnectionEvents)
    .where(eq(managedConnectionEvents.connectionId, connectionId));

/**
 * Disconnecting deletes the credentials at once and then sends one
 * revocation request, never retried (decision 6). The connection stays as a
 * tombstone that a later connect reuses.
 */
describe("managed connection disconnect", () => {
  const harness = createManagedConnectionHarness({ slowMs: 400 });
  const { fake, origin } = harness;

  afterEach(() => {
    fake.reset();
  });

  afterAll(async () => {
    await fake.stop();
  });

  test("disconnect deletes the credentials and revokes once", async () => {
    const { owner, projectId, connectionId, ready } =
      await harness.connectToReady("disconnect-ready");
    const refreshToken = fake.issuedTokens[1];

    const response = await harness.disconnect(owner, projectId, connectionId);

    expect(response).toMatchObject({
      revocation: "accepted",
      providerRemovalUrl: MANAGED_CONNECTION_PRESETS.notion.removalUrl,
      connection: {
        id: connectionId,
        state: "disconnected",
        generation: ready.generation + 1,
        account: null,
        candidate: null,
      },
    });
    const revocations = fake.callsTo("revoke");
    expect(revocations).toHaveLength(1);
    expect(revocations[0]?.params["token"]).toBe(refreshToken);
    const grants = await grantRowsOf(connectionId);
    expect(grants).toHaveLength(1);
    expect(grants[0]?.credentialsCiphertext).toBeNull();
    expect(grants[0]?.retiredAt).toBeInstanceOf(Date);
    const events = await eventsOf(connectionId);
    const revocationEvent = events.find(
      (event) => event.type === "revocation_attempted",
    );
    if (!revocationEvent) {
      throw new Error("expected a revocation event");
    }
    expect(response.connection.lastRevocation).toEqual({
      outcome: "accepted",
      at: revocationEvent.createdAt.toISOString(),
    });
    expect(
      (await harness.getConnection(owner, projectId, connectionId))
        .lastRevocation,
    ).toEqual(response.connection.lastRevocation);
    expect(
      events
        .filter((event) => event.generation === ready.generation + 1)
        .map(({ type, revocationOutcome }) => ({ type, revocationOutcome }))
        .sort((a, b) => a.type.localeCompare(b.type)),
    ).toEqual([
      { type: "disconnected", revocationOutcome: null },
      { type: "revocation_attempted", revocationOutcome: "accepted" },
    ]);
  });

  test("a provider error is reported as failed", async () => {
    const { owner, projectId, connectionId } =
      await harness.connectToReady("disconnect-5xx");
    fake.faults.revoke = "server_error";

    const response = await harness.disconnect(owner, projectId, connectionId);

    expect(response.revocation).toBe("failed");
    expect(response.connection.lastRevocation?.outcome).toBe("failed");
    expect(
      (await harness.getConnection(owner, projectId, connectionId))
        .lastRevocation,
    ).toEqual(response.connection.lastRevocation);
    expect(fake.callsTo("revoke")).toHaveLength(1);
  });

  test("history uses the latest revocation in the current generation and expires with events", async () => {
    const { owner, projectId, connectionId } =
      await harness.connectToReady("disconnect-history");
    const { connection } = await harness.disconnect(
      owner,
      projectId,
      connectionId,
    );
    const at = new Date(Date.now() + 1_000);
    await getDb()
      .insert(managedConnectionEvents)
      .values([
        {
          id: createUuidV7(),
          projectId,
          connectionId,
          type: "revocation_attempted",
          generation: connection.generation,
          revocationOutcome: "failed",
          createdAt: at,
        },
        {
          id: createUuidV7(),
          projectId,
          connectionId,
          type: "revocation_attempted",
          generation: connection.generation - 1,
          revocationOutcome: "unconfirmed",
          createdAt: new Date(at.getTime() + 1_000),
        },
      ]);
    expect(
      (await harness.getConnection(owner, projectId, connectionId))
        .lastRevocation,
    ).toEqual({ outcome: "failed", at: at.toISOString() });

    await getDb()
      .delete(managedConnectionEvents)
      .where(eq(managedConnectionEvents.connectionId, connectionId));
    expect(
      (await harness.getConnection(owner, projectId, connectionId))
        .lastRevocation,
    ).toBeNull();
  });

  test("disconnecting a pending reconnect deletes its candidate as well", async () => {
    const {
      owner,
      projectId,
      connectionId,
      candidate: first,
    } = await harness.connectToReady("disconnect-pending");
    const { candidate } = await harness.reconnectToCandidate(
      owner,
      projectId,
      connectionId,
    );

    const response = await harness.disconnect(owner, projectId, connectionId);

    expect(response.revocation).toBe("accepted");
    expect(fake.callsTo("revoke")).toHaveLength(1);
    const grants = await grantRowsOf(connectionId);
    expect(grants.map((grant) => grant.id)).toEqual([first.id]);
    expect(grants.map((grant) => grant.id)).not.toContain(candidate.id);
    expect(grants[0]?.credentialsCiphertext).toBeNull();
  });

  test("a reconnect exchange in flight during disconnect leaves no ciphertext anywhere", async () => {
    const { owner, projectId, connectionId } = await harness.connectToReady(
      "disconnect-inflight",
    );
    const callbackUrl = await harness.reconnectToCallback(
      owner,
      projectId,
      connectionId,
    );
    fake.faults.token = "slow";

    const landing = harness.callback(callbackUrl, owner.authHeaders);
    await Bun.sleep(100);
    const response = await harness.disconnect(owner, projectId, connectionId);
    const { location } = await landing;

    expect(response.connection.state).toBe("disconnected");
    expect(location.searchParams.get("error")).toBe("stale_generation");
    expect(fake.callsTo("token")).toHaveLength(2);
    for (const grant of await grantRowsOf(connectionId)) {
      expect(grant.credentialsCiphertext).toBeNull();
    }
    expect(await grantRowsOf(connectionId)).toHaveLength(1);
    for (const attempt of await attemptRowsOf(connectionId)) {
      expect(["cancelled", "succeeded", "failed"]).toContain(attempt.status);
      expect(attempt.pkceVerifierCiphertext).toBeNull();
    }
    const connection = await harness.getConnection(
      owner,
      projectId,
      connectionId,
    );
    expect(connection).toMatchObject({
      state: "disconnected",
      candidate: null,
    });
  });

  test("disconnecting before anything is connected skips revocation", async () => {
    const { owner, projectId, connectionId } = await harness.connectToCandidate(
      "disconnect-candidate",
    );

    const response = await harness.disconnect(owner, projectId, connectionId);

    expect(response.revocation).toBeNull();
    expect(response.connection.lastRevocation).toBeNull();
    expect(response.connection.state).toBe("disconnected");
    expect(fake.callsTo("revoke")).toHaveLength(0);
    expect(await grantRowsOf(connectionId)).toEqual([]);
  });

  test("disconnecting twice is a conflict", async () => {
    const { owner, projectId, connectionId } =
      await harness.connectToReady("disconnect-twice");
    await harness.disconnect(owner, projectId, connectionId);

    const { error } = await harness
      .connections(projectId)({ connectionId })
      .delete(undefined, { headers: { ...owner.authHeaders, origin } });

    expect(error?.status).toBe(409);
    expect(error?.value).toMatchObject({
      code: "MANAGED_CONNECTION_STATE_CONFLICT",
    });
    expect(fake.callsTo("revoke")).toHaveLength(1);
  });

  test("connecting again reuses the tombstone's ID", async () => {
    const { owner, projectId, connectionId } = await harness.connectToReady(
      "disconnect-reconnect",
    );
    await harness.disconnect(owner, projectId, connectionId);

    const started = await harness.startConnect(owner, projectId);

    expect(started.connectionId).toBe(connectionId);
  });

  test("disconnecting needs a trusted Origin", async () => {
    const { owner, projectId, connectionId } =
      await harness.connectToReady("disconnect-origin");

    const { error } = await harness
      .connections(projectId)({ connectionId })
      .delete(undefined, {
        headers: { ...owner.authHeaders, origin: "https://evil.example" },
      });

    expect(error?.status).toBe(403);
    expect(fake.callsTo("revoke")).toHaveLength(0);
  });
});

describe("managed connection disconnect with a slow revocation endpoint", () => {
  const harness = createManagedConnectionHarness({
    slowMs: 1_000,
    outboundTimeoutMs: 200,
  });
  const { fake, origin } = harness;

  afterAll(async () => {
    await fake.stop();
  });

  test("a revocation timeout still succeeds, as unconfirmed, without retrying", async () => {
    const { owner, projectId, connectionId } =
      await harness.connectToReady("disconnect-timeout");
    fake.faults.revoke = "slow";

    const { data, status } = await harness
      .connections(projectId)({ connectionId })
      .delete(undefined, { headers: { ...owner.authHeaders, origin } });

    expect(status).toBe(200);
    expect(data?.revocation).toBe("unconfirmed");
    expect(data?.connection.lastRevocation?.outcome).toBe("unconfirmed");
    expect(
      (await harness.getConnection(owner, projectId, connectionId))
        .lastRevocation,
    ).toEqual(data?.connection.lastRevocation ?? null);
    expect(data?.connection.state).toBe("disconnected");
    expect(fake.callsTo("revoke")).toHaveLength(1);
    const outcomes = (await eventsOf(connectionId))
      .filter((event) => event.type === "revocation_attempted")
      .map((event) => event.revocationOutcome);
    expect(outcomes).toEqual(["unconfirmed"]);
  });
});
