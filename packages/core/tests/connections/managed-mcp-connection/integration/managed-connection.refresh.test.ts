import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { parseUuidV7 } from "@/common/contracts/uuid-v7";
import {
  acquireManagedAccessToken,
  forceRefreshManagedAccessToken,
  type AcquireManagedAccessTokenDeps,
} from "@/connections/managed-mcp-connection/application/acquire-managed-access-token";
import { MANAGED_REFRESH_STALE_MS } from "@/connections/managed-mcp-connection/domain/managed-oauth-grant-entity";
import { getDb } from "@/lib/db";
import { managedConnectionEvents, managedOAuthGrants } from "@/lib/db/schema";
import { CoreError } from "@/lib/errors";
import {
  createManagedConnectionHarness,
  overrideManagedOAuthProviders,
} from "./managed-connection-test-support";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const eventsOf = async (connectionId: string) =>
  await getDb()
    .select({
      type: managedConnectionEvents.type,
      reasonCode: managedConnectionEvents.reasonCode,
    })
    .from(managedConnectionEvents)
    .where(eq(managedConnectionEvents.connectionId, connectionId));

const grantRowOf = async (grantId: string) => {
  const [row] = await getDb()
    .select({
      credentialsCiphertext: managedOAuthGrants.credentialsCiphertext,
      credentialVersion: managedOAuthGrants.credentialVersion,
      refreshClaimId: managedOAuthGrants.refreshClaimId,
      retiredAt: managedOAuthGrants.retiredAt,
    })
    .from(managedOAuthGrants)
    .where(eq(managedOAuthGrants.id, grantId));
  if (!row) {
    throw new Error(`expected grant ${grantId}`);
  }
  return row;
};

const failureOf = async (promise: Promise<object>): Promise<Error> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw error;
  }
  throw new Error("expected the call to fail");
};

const codeOf = (reason: object): string | null =>
  reason instanceof CoreError ? reason.code : null;

const waitFor = async (condition: () => boolean) => {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for condition");
    }
    await Bun.sleep(5);
  }
};

/**
 * On-demand refresh (ADR 0013 decisions 12–15): one refresh per connection,
 * claimed in Postgres; unknown outcomes and lost claims move the connection
 * to `reconnect_required` and never replay the refresh token; a result that
 * comes back after the grant changed is dropped.
 */
describe("managed connection refresh", () => {
  const harness = createManagedConnectionHarness({ slowMs: 400 });
  const { fake, clock, appContext } = harness;

  afterEach(() => {
    fake.reset();
    clock.reset();
  });

  afterAll(async () => {
    await fake.stop();
  });

  const ready = async (label: string) => {
    const started = await harness.connectToReady(label);
    return {
      ...started,
      input: {
        projectId: parseUuidV7(started.projectId),
        connectionId: parseUuidV7(started.connectionId),
      },
      grantId: started.candidate.id,
    };
  };

  const acquire = (
    input: Parameters<typeof acquireManagedAccessToken>[0],
    deps: AcquireManagedAccessTokenDeps = appContext,
  ) => acquireManagedAccessToken(input, deps);

  const stateOf = async (connected: Awaited<ReturnType<typeof ready>>) =>
    await harness.getConnection(
      connected.owner,
      connected.projectId,
      connected.connectionId,
    );

  test("a token good for more than 60 s is returned without refreshing", async () => {
    const connected = await ready("refresh-valid");
    const accessToken = fake.issuedTokens[0];

    const token = await acquire(connected.input);

    expect(token).toEqual({
      accessToken: accessToken ?? "",
      generation: connected.ready.generation,
      grantId: parseUuidV7(connected.grantId),
      server: harness.fakeTarget.server,
    });
    expect(Object.values(token)).not.toContain(fake.issuedTokens[1]);
    expect(fake.refreshCount).toBe(0);
  });

  for (const callers of [2, 10]) {
    test(`${String(callers)} concurrent callers with an expired token refresh once`, async () => {
      const connected = await ready(`refresh-race-${String(callers)}`);
      clock.advance(HOUR_MS);
      fake.faults.refresh = "slow";

      const results = await Promise.allSettled(
        Array.from({ length: callers }, () => acquire(connected.input)),
      );

      expect(fake.refreshCount).toBe(1);
      const fulfilled = results.filter(
        (result) => result.status === "fulfilled",
      );
      const rejected = results.filter((result) => result.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected.map((result) => codeOf(result.reason as Error))).toEqual(
        Array.from(
          { length: callers - 1 },
          () => "MANAGED_CONNECTION_REFRESH_BUSY",
        ),
      );
      const busy = rejected[0]?.reason as Error | undefined;
      expect(busy).toMatchObject({
        status: 503,
        meta: { retryAfterSeconds: 1 },
      });
      const refreshed = fulfilled[0]?.value.accessToken;
      expect(refreshed).toBe(fake.issuedTokens.at(-2));

      fake.faults = {};
      const next = await acquire(connected.input);
      expect(next.accessToken).toBe(refreshed ?? "");
      expect(fake.refreshCount).toBe(1);
      const row = await grantRowOf(connected.grantId);
      expect(row.credentialVersion).toBe(2);
      expect(row.refreshClaimId).toBeNull();
      const events = await eventsOf(connected.connectionId);
      expect(
        events.filter((event) => event.type === "refresh_succeeded"),
      ).toHaveLength(1);
    });
  }

  test("a rotated refresh token is the one sent next time; the old one never again", async () => {
    const connected = await ready("refresh-rotate");
    const original = fake.issuedTokens[1];

    clock.advance(HOUR_MS);
    const first = await acquire(connected.input);
    const rotated = fake.issuedTokens.at(-1);
    clock.advance(HOUR_MS);
    const second = await acquire(connected.input);

    const sent = fake
      .callsTo("refresh")
      .map((call) => call.params["refresh_token"]);
    expect(sent).toEqual([original, rotated]);
    expect(new Set(sent).size).toBe(sent.length);
    expect(second.accessToken).not.toBe(first.accessToken);
    expect((await grantRowOf(connected.grantId)).credentialVersion).toBe(3);
    expect((await stateOf(connected)).state).toBe("ready");
  });

  test("forceRefresh refreshes once for two rejections of the same token", async () => {
    const connected = await ready("refresh-force");
    const before = await acquire(connected.input);
    const forced = {
      ...connected.input,
      rejectedAccessToken: before.accessToken,
    };

    const first = await forceRefreshManagedAccessToken(forced, appContext);
    const second = await forceRefreshManagedAccessToken(forced, appContext);

    expect(fake.refreshCount).toBe(1);
    expect(first.accessToken).not.toBe(before.accessToken);
    expect(second.accessToken).toBe(first.accessToken);
  });

  test("a response dropped after rotation ends reconnect_required and is never retried", async () => {
    const dropping = createManagedConnectionHarness({
      slowMs: 1_000,
      outboundTimeoutMs: 200,
    });
    try {
      const started = await dropping.connectToReady("refresh-drop");
      const input = {
        projectId: parseUuidV7(started.projectId),
        connectionId: parseUuidV7(started.connectionId),
      };
      dropping.clock.advance(HOUR_MS);
      dropping.fake.faults.refresh = "drop_response_after_rotate";

      const failed = await failureOf(
        acquireManagedAccessToken(input, dropping.appContext),
      );

      expect(failed).toMatchObject({
        code: "MANAGED_CONNECTION_NOT_READY",
        meta: { state: "reconnect_required", reasonCode: "refresh_failed" },
      });
      expect(dropping.fake.refreshCount).toBe(1);
      const later = await failureOf(
        acquireManagedAccessToken(input, dropping.appContext),
      );
      expect(codeOf(later)).toBe("MANAGED_CONNECTION_NOT_READY");
      expect(dropping.fake.refreshCount).toBe(1);
      const connection = await dropping.getConnection(
        started.owner,
        started.projectId,
        started.connectionId,
      );
      expect(connection).toMatchObject({
        state: "reconnect_required",
        reasonCode: "refresh_failed",
      });
      const events = await eventsOf(started.connectionId);
      expect(events).toContainEqual({
        type: "refresh_failed",
        reasonCode: "refresh_unknown",
      });
      expect(events).toContainEqual({
        type: "reconnect_required",
        reasonCode: "refresh_failed",
      });
    } finally {
      await dropping.fake.stop();
    }
  });

  test.each([
    ["invalid_grant", "refresh_rejected"],
    ["invalid_client", "refresh_client_rejected"],
    ["server_error", "refresh_server_error"],
  ] as const)(
    "a %s refresh moves the connection to reconnect_required",
    async (fault, reasonCode) => {
      const connected = await ready(`refresh-${fault}`);
      clock.advance(HOUR_MS);
      fake.faults.refresh = fault;

      const failed = await failureOf(acquire(connected.input));

      expect(failed).toMatchObject({
        code: "MANAGED_CONNECTION_NOT_READY",
        status: 409,
        meta: { state: "reconnect_required", reasonCode: "refresh_failed" },
      });
      expect(fake.refreshCount).toBe(1);
      expect(await stateOf(connected)).toMatchObject({
        state: "reconnect_required",
        reasonCode: "refresh_failed",
      });
      expect(await eventsOf(connected.connectionId)).toContainEqual({
        type: "refresh_failed",
        reasonCode,
      });
      expect((await grantRowOf(connected.grantId)).refreshClaimId).toBeNull();
    },
  );

  test("a refresh that was never sent releases the claim and keeps the grant", async () => {
    const connected = await ready("refresh-not-attempted");
    clock.advance(HOUR_MS);
    const provider = overrideManagedOAuthProviders(
      appContext.managedOAuthProviders,
      { refresh: () => Promise.resolve({ status: "not_attempted" as const }) },
    );

    const failed = await failureOf(
      acquire(connected.input, {
        ...appContext,
        managedOAuthProviders: provider,
      }),
    );

    expect(failed).toMatchObject({
      code: "MANAGED_CONNECTION_PROVIDER_UNAVAILABLE",
      status: 502,
    });
    expect((await stateOf(connected)).state).toBe("ready");
    const row = await grantRowOf(connected.grantId);
    expect(row).toMatchObject({ refreshClaimId: null, credentialVersion: 1 });
    expect(await eventsOf(connected.connectionId)).toContainEqual({
      type: "refresh_failed",
      reasonCode: "refresh_not_attempted",
    });

    const retried = await acquire(connected.input);
    expect(fake.refreshCount).toBe(1);
    expect(retried.accessToken).toBe(fake.issuedTokens.at(-2) ?? "");
  });

  test("a crash after claiming is recovered to reconnect_required after 30 s without refreshing", async () => {
    const connected = await ready("refresh-crash");
    clock.advance(HOUR_MS);
    const crashing = overrideManagedOAuthProviders(
      appContext.managedOAuthProviders,
      { refresh: () => Promise.reject(new Error("crashed before send")) },
    );

    const crashed = await failureOf(
      acquire(connected.input, {
        ...appContext,
        managedOAuthProviders: crashing,
      }),
    );
    expect(crashed).toBeInstanceOf(Error);
    expect(crashed.message).toBe("crashed before send");
    expect((await grantRowOf(connected.grantId)).refreshClaimId).not.toBeNull();

    const busy = await failureOf(acquire(connected.input));
    expect(codeOf(busy)).toBe("MANAGED_CONNECTION_REFRESH_BUSY");

    clock.advance(MANAGED_REFRESH_STALE_MS + 1_000);
    const recovered = await failureOf(acquire(connected.input));

    expect(recovered).toMatchObject({
      code: "MANAGED_CONNECTION_NOT_READY",
      meta: { state: "reconnect_required", reasonCode: "refresh_failed" },
    });
    expect(fake.refreshCount).toBe(0);
    expect(await stateOf(connected)).toMatchObject({
      state: "reconnect_required",
      reasonCode: "refresh_failed",
    });
    expect((await grantRowOf(connected.grantId)).refreshClaimId).toBeNull();
    const events = await eventsOf(connected.connectionId);
    expect(events.map((event) => event.type)).toContain(
      "refresh_claim_recovered",
    );
  });

  test("past reconnectBy the connection moves to reconnect_required (grant_expired)", async () => {
    const connected = await ready("refresh-grant-expired");
    clock.advance(181 * DAY_MS);

    const failed = await failureOf(acquire(connected.input));

    expect(failed).toMatchObject({
      code: "MANAGED_CONNECTION_NOT_READY",
      meta: { state: "reconnect_required", reasonCode: "grant_expired" },
    });
    expect(fake.refreshCount).toBe(0);
    expect(await eventsOf(connected.connectionId)).toContainEqual({
      type: "reconnect_required",
      reasonCode: "grant_expired",
    });
  });

  test("a disconnect during an in-flight refresh drops its result", async () => {
    const connected = await ready("refresh-disconnect");
    clock.advance(HOUR_MS);
    fake.faults.refresh = "slow";

    const inFlight = failureOf(acquire(connected.input));
    await waitFor(() => fake.refreshCount === 1);
    await harness.disconnect(
      connected.owner,
      connected.projectId,
      connected.connectionId,
    );

    expect(codeOf(await inFlight)).toBe("MANAGED_CONNECTION_CHANGED");
    const row = await grantRowOf(connected.grantId);
    expect(row).toMatchObject({
      credentialsCiphertext: null,
      refreshClaimId: null,
      credentialVersion: 1,
    });
    expect(row.retiredAt).toBeInstanceOf(Date);
    const events = await eventsOf(connected.connectionId);
    expect(events.map((event) => event.type)).not.toContain(
      "refresh_succeeded",
    );
    expect((await stateOf(connected)).state).toBe("disconnected");
  });

  test("a reconnect confirmed during an in-flight refresh of the old grant drops its result", async () => {
    const connected = await ready("refresh-reconnect");
    clock.advance(HOUR_MS);
    const { pending, candidate } = await harness.reconnectToCandidate(
      connected.owner,
      connected.projectId,
      connected.connectionId,
    );
    const newGrantBefore = await grantRowOf(candidate.id);
    fake.faults.refresh = "slow";

    const inFlight = failureOf(acquire(connected.input));
    await waitFor(() => fake.refreshCount === 1);
    const confirmed = await harness
      .connections(connected.projectId)({
        connectionId: connected.connectionId,
      })
      .candidate.confirm.post(
        {
          candidateId: candidate.id,
          fingerprint: candidate.fingerprint,
          expectedVersion: pending.version,
        },
        { headers: { ...connected.owner.authHeaders, origin: harness.origin } },
      );
    expect(confirmed.data?.state).toBe("ready");

    expect(codeOf(await inFlight)).toBe("MANAGED_CONNECTION_CHANGED");
    expect(await grantRowOf(candidate.id)).toEqual(newGrantBefore);
    const oldGrant = await grantRowOf(connected.grantId);
    expect(oldGrant.credentialsCiphertext).toBeNull();
    expect(oldGrant.credentialVersion).toBe(1);

    fake.faults = {};
    const token = await acquire(connected.input);
    expect(token.grantId).toBe(parseUuidV7(candidate.id));
    expect(token.generation).toBe(connected.ready.generation + 1);
    expect(fake.refreshCount).toBe(1);
  });
});
