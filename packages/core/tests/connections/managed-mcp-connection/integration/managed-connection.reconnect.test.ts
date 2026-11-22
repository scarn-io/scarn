import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { parseUuidV7 } from "@/common/contracts/uuid-v7";
import { getDb } from "@/lib/db";
import { managedConnectionEvents } from "@/lib/db/schema";
import { createManagedConnectionHarness } from "./managed-connection-test-support";

/**
 * Reconnecting keeps the active grant serving until the new candidate is
 * confirmed (decision 5). Replacing or cancelling never calls the provider's
 * revocation endpoint (decision 16).
 */
describe("managed connection reconnect", () => {
  const harness = createManagedConnectionHarness();
  const { fake, origin, appContext } = harness;

  afterEach(() => {
    fake.reset();
  });

  afterAll(async () => {
    await fake.stop();
  });

  const loadGrant = async (
    projectId: string,
    connectionId: string,
    grantId: string,
  ) => {
    const grant = await appContext.managedOAuthGrantRepo.findById(
      parseUuidV7(projectId),
      parseUuidV7(connectionId),
      parseUuidV7(grantId),
    );
    if (!grant) {
      throw new Error(`expected grant ${grantId}`);
    }
    return grant;
  };

  const decryptCredentials = (grant: Awaited<ReturnType<typeof loadGrant>>) => {
    if (grant.credentials.status !== "live") {
      throw new Error("expected live credentials");
    }
    return appContext.managedGrantCrypto.decryptCredentials(
      {
        projectId: grant.projectId,
        connectionId: grant.connectionId,
        grantId: grant.id,
        credentialVersion: grant.credentialVersion,
      },
      grant.credentials.encryptedCredentials,
    );
  };

  test("a reconnect keeps the active grant serving until its candidate is confirmed", async () => {
    const { owner, projectId, connectionId, ready } =
      await harness.connectToReady("reconnect-pending");

    const started = await harness.startReconnect(
      owner,
      projectId,
      connectionId,
    );
    expect(started.connectionId).toBe(connectionId);
    const { pending, candidate } = await harness.reconnectToCandidate(
      owner,
      projectId,
      connectionId,
    );

    expect(pending).toMatchObject({
      id: connectionId,
      state: "ready_with_pending_reconnect",
      generation: ready.generation,
      account: ready.account,
      candidate: { id: candidate.id, sameIdentityAsActive: true },
    });
  });

  test("a fresh connect clears the prior revocation outcome even when generation is unchanged", async () => {
    const { owner, projectId, connectionId, ready } =
      await harness.connectToReady("reconnect-revocation");
    expect(ready.lastRevocation).toBeNull();
    const disconnected = await harness.disconnect(
      owner,
      projectId,
      connectionId,
    );
    const started = await harness.startConnect(owner, projectId);
    expect(started.connectionId).toBe(connectionId);
    const connecting = await harness.getConnection(
      owner,
      projectId,
      connectionId,
    );
    expect(disconnected.connection.lastRevocation?.outcome).toBe("accepted");
    expect(connecting.lastRevocation).toBeNull();
    const callbackUrl = await harness.authorize(started.authorizationUrl);
    await harness.callback(callbackUrl, owner.authHeaders);
    const pending = await harness.getConnection(owner, projectId, connectionId);
    const candidate = pending.candidate;
    if (!candidate) {
      throw new Error("expected a fresh candidate");
    }
    const confirmed = await harness
      .connections(projectId)({ connectionId })
      .candidate.confirm.post(
        {
          candidateId: candidate.id,
          fingerprint: candidate.fingerprint,
          expectedVersion: pending.version,
        },
        { headers: { ...owner.authHeaders, origin } },
      );
    expect(confirmed.error).toBeNull();
    expect(confirmed.data?.generation).toBe(disconnected.connection.generation);
    expect(confirmed.data?.lastRevocation).toBeNull();
    expect(
      (await harness.getConnection(owner, projectId, connectionId))
        .lastRevocation,
    ).toBeNull();
  });

  test("reconnect then cancel leaves the old grant decryptable and unchanged", async () => {
    const {
      owner,
      projectId,
      connectionId,
      candidate: first,
    } = await harness.connectToReady("reconnect-cancel");
    const before = await loadGrant(projectId, connectionId, first.id);
    const beforeCredentials = decryptCredentials(before);

    const { candidate } = await harness.reconnectToCandidate(
      owner,
      projectId,
      connectionId,
    );
    const cancelled = await harness
      .connections(projectId)({ connectionId })
      .candidate.cancel.post(
        { candidateId: candidate.id },
        { headers: { ...owner.authHeaders, origin } },
      );

    expect(cancelled.data).toMatchObject({ state: "ready", candidate: null });
    const after = await loadGrant(projectId, connectionId, first.id);
    expect(after.credentialVersion).toBe(before.credentialVersion);
    expect(after.updatedAt).toEqual(before.updatedAt);
    expect(decryptCredentials(after)).toEqual(beforeCredentials);
    expect(
      await appContext.managedOAuthGrantRepo.findById(
        parseUuidV7(projectId),
        parseUuidV7(connectionId),
        parseUuidV7(candidate.id),
      ),
    ).toBeNull();
    expect(fake.callsTo("revoke")).toHaveLength(0);
  });

  test("reconnect then confirm retires the old grant and keeps the connection ID", async () => {
    const {
      owner,
      projectId,
      connectionId,
      ready,
      candidate: first,
    } = await harness.connectToReady("reconnect-confirm");

    const { pending, candidate } = await harness.reconnectToCandidate(
      owner,
      projectId,
      connectionId,
    );
    const confirmed = await harness
      .connections(projectId)({ connectionId })
      .candidate.confirm.post(
        {
          candidateId: candidate.id,
          fingerprint: candidate.fingerprint,
          expectedVersion: pending.version,
        },
        { headers: { ...owner.authHeaders, origin } },
      );

    expect(confirmed.data).toMatchObject({
      id: connectionId,
      state: "ready",
      generation: ready.generation + 1,
      candidate: null,
    });
    const old = await loadGrant(projectId, connectionId, first.id);
    expect(old.credentials.status).toBe("retired");
    const active = await loadGrant(projectId, connectionId, candidate.id);
    expect(active.isRetired).toBe(false);
    const [confirmedEvent] = (
      await getDb()
        .select()
        .from(managedConnectionEvents)
        .where(eq(managedConnectionEvents.connectionId, connectionId))
    ).filter(
      (event) =>
        event.type === "candidate_confirmed" &&
        event.generation === ready.generation + 1,
    );
    expect(confirmedEvent?.sameIdentityAsActive).toBe(true);
    expect(fake.callsTo("revoke")).toHaveLength(0);
  });

  test("a new reconnect replaces one in flight, whose callback then fails", async () => {
    const { owner, projectId, connectionId } =
      await harness.connectToReady("reconnect-replace");

    const firstCallback = await harness.reconnectToCallback(
      owner,
      projectId,
      connectionId,
    );
    await harness.startReconnect(owner, projectId, connectionId);
    const { location } = await harness.callback(
      firstCallback,
      owner.authHeaders,
    );

    expect(location.searchParams.get("error")).toBe("invalid_callback");
    const connection = await harness.getConnection(
      owner,
      projectId,
      connectionId,
    );
    expect(connection).toMatchObject({ state: "ready", candidate: null });
  });

  test("a connection without a grant can't be reconnected", async () => {
    const { owner, projectId, connectionId } = await harness.connectToCallback(
      "reconnect-connecting",
    );

    const { error } = await harness
      .connections(projectId)({ connectionId })
      .reconnect.post(undefined, {
        headers: { ...owner.authHeaders, origin },
      });

    expect(error?.status).toBe(409);
    expect(error?.value).toMatchObject({
      code: "MANAGED_CONNECTION_STATE_CONFLICT",
    });
  });

  test("reconnecting needs a trusted Origin", async () => {
    const { owner, projectId, connectionId } =
      await harness.connectToReady("reconnect-origin");

    const { error } = await harness
      .connections(projectId)({ connectionId })
      .reconnect.post(undefined, {
        headers: { ...owner.authHeaders, origin: "https://evil.example" },
      });

    expect(error?.status).toBe(403);
  });
});
