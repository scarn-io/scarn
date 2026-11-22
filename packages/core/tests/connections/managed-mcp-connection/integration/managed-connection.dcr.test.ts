import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { parseUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import { acquireManagedAccessToken } from "@/connections/managed-mcp-connection/application/acquire-managed-access-token";
import { getDb } from "@/lib/db";
import {
  managedConnectionEvents,
  managedOAuthAttempts,
  managedOAuthClients,
} from "@/lib/db/schema";
import {
  FAKE_REGISTRATION_CANARY,
  type FakeMcpRegisterFault,
} from "tests/connections/support/fake-mcp-oauth";
import {
  createProjectSecretsTestProject,
  createProjectSecretsTestUser,
  type ProjectSecretsTestUser,
} from "tests/secrets/secret/integration/project-secret-test-support";
import { startConnectionFromDefinition } from "./managed-connection-fake-presets";
import {
  createManagedConnectionHarness,
  MANAGED_CONNECTION_APP_URL,
} from "./managed-connection-test-support";

const HOUR_MS = 60 * 60 * 1000;

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

/**
 * Dynamic client registration (ADR 0013 decision 43) against the fake in
 * `dcr` mode: Scarn registers one public client per authorization server
 * and redirect URI, shares it across projects and connections, registers
 * again once the server stops recognising it, and refuses a registration
 * that isn't a public client for its own redirect URI.
 */
describe("managed connection dynamic client registration", () => {
  const harness = createManagedConnectionHarness({
    clientRegistration: "dcr",
    slowMs: 300,
  });
  const { fake, clock, appContext, origin } = harness;

  const clientRows = async () =>
    await getDb()
      .select({
        clientId: managedOAuthClients.clientId,
        redirectUri: managedOAuthClients.redirectUri,
        staleAt: managedOAuthClients.staleAt,
      })
      .from(managedOAuthClients)
      .where(eq(managedOAuthClients.issuer, fake.origin));

  const liveClientIds = async () =>
    (await clientRows())
      .filter((row) => row.staleAt === null)
      .map((row) => row.clientId);

  const clientIdOf = (authorizationUrl: string) =>
    new URL(authorizationUrl).searchParams.get("client_id");

  const newProject = async (label: string) => {
    const owner = await createProjectSecretsTestUser(label);
    const projectId = await createProjectSecretsTestProject(
      harness.apiClient,
      owner,
    );
    return { owner, projectId };
  };

  const postConnect = async (
    owner: ProjectSecretsTestUser,
    projectId: UuidV7,
  ) =>
    await harness
      .connections(projectId)
      .post(
        { preset: "notion" },
        { headers: { ...owner.authHeaders, origin } },
      );

  afterEach(async () => {
    fake.reset();
    clock.reset();
    await getDb()
      .delete(managedOAuthClients)
      .where(eq(managedOAuthClients.issuer, fake.origin));
  });

  afterAll(async () => {
    await fake.stop();
  });

  test("the first connect registers one public client and stores it", async () => {
    const { ready, authorizationUrl } =
      await harness.connectToReady("dcr-first");

    expect(ready.state).toBe("ready");
    const [registration] = fake.callsTo("register");
    expect(fake.callsTo("register")).toHaveLength(1);
    expect(registration?.method).toBe("POST");
    const rows = await clientRows();
    expect(rows).toEqual([
      {
        clientId: fake.registrations.registered[0] ?? "",
        redirectUri: `${MANAGED_CONNECTION_APP_URL}/api/oauth/mcp/callback`,
        staleAt: null,
      },
    ]);
    expect(clientIdOf(authorizationUrl)).toBe(rows[0]?.clientId ?? null);
  });

  test("another project and a connection without a preset reuse the client", async () => {
    const first = await harness.connectToReady("dcr-reuse-first");
    const clientId = clientIdOf(first.authorizationUrl);

    const second = await harness.connectToReady("dcr-reuse-second");
    const direct = await newProject("dcr-reuse-direct");
    const started = await startConnectionFromDefinition(
      appContext,
      direct.owner,
      direct.projectId,
      {
        name: "docs-direct",
        label: "Docs direct",
        preset: null,
        server: harness.fakeTarget.server,
      },
    );

    expect(clientIdOf(second.authorizationUrl)).toBe(clientId);
    expect(clientIdOf(started.authorizationUrl)).toBe(clientId);
    expect(fake.callsTo("register")).toHaveLength(1);
    expect(await liveClientIds()).toEqual([clientId ?? ""]);
  });

  test("two concurrent first connects both proceed and store one client", async () => {
    fake.faults.register = "slow";

    const [a, b] = await Promise.all([
      harness.connectToCallback("dcr-race-a"),
      harness.connectToCallback("dcr-race-b"),
    ]);

    expect(fake.callsTo("register")).toHaveLength(2);
    const live = await liveClientIds();
    expect(live).toHaveLength(1);
    expect(clientIdOf(a.authorizationUrl)).toBe(live[0] ?? null);
    expect(clientIdOf(b.authorizationUrl)).toBe(live[0] ?? null);
    expect(a.callbackUrl.searchParams.get("code")).not.toBeNull();
    expect(b.callbackUrl.searchParams.get("code")).not.toBeNull();
  });

  test("invalid_client on refresh marks the client stale; the next connect registers again", async () => {
    const connected = await harness.connectToReady("dcr-refresh-stale");
    const oldClientId = clientIdOf(connected.authorizationUrl);
    clock.advance(HOUR_MS);
    fake.registrations.forget();

    const failed = await failureOf(
      acquireManagedAccessToken(
        {
          projectId: parseUuidV7(connected.projectId),
          connectionId: parseUuidV7(connected.connectionId),
        },
        appContext,
      ),
    );

    expect(failed).toMatchObject({
      code: "MANAGED_CONNECTION_NOT_READY",
      meta: { state: "reconnect_required", reasonCode: "refresh_failed" },
    });
    expect(fake.callsTo("refresh")[0]?.params["client_id"]).toBe(
      oldClientId ?? "",
    );
    expect(
      await harness.getConnection(
        connected.owner,
        connected.projectId,
        connected.connectionId,
      ),
    ).toMatchObject({
      state: "reconnect_required",
      reasonCode: "refresh_failed",
    });
    expect(
      await getDb()
        .select({
          type: managedConnectionEvents.type,
          reasonCode: managedConnectionEvents.reasonCode,
        })
        .from(managedConnectionEvents)
        .where(
          eq(managedConnectionEvents.connectionId, connected.connectionId),
        ),
    ).toContainEqual({
      type: "refresh_failed",
      reasonCode: "refresh_client_rejected",
    });
    expect(await liveClientIds()).toEqual([]);

    const next = await harness.connectToReady("dcr-refresh-next");

    expect(fake.callsTo("register")).toHaveLength(2);
    const live = await liveClientIds();
    expect(live).toHaveLength(1);
    expect(live[0]).not.toBe(oldClientId);
    expect(clientIdOf(next.authorizationUrl)).toBe(live[0] ?? null);
    expect(await clientRows()).toHaveLength(2);
  });

  test("invalid_client on the code exchange marks the client stale", async () => {
    const started = await harness.connectToCallback("dcr-exchange-stale");
    fake.faults.token = "invalid_client";

    const { location } = await harness.callback(
      started.callbackUrl,
      started.owner.authHeaders,
    );

    expect(location.searchParams.get("error")).toBe("client_configuration");
    const [attempt] = await getDb()
      .select({ failureCode: managedOAuthAttempts.failureCode })
      .from(managedOAuthAttempts)
      .where(eq(managedOAuthAttempts.connectionId, started.connectionId));
    expect(attempt?.failureCode).toBe("client_configuration");
    expect(await liveClientIds()).toEqual([]);
  });

  test.each([
    "client_secret",
    "other_redirect_uris",
    "other_auth_method",
  ] as const satisfies readonly FakeMcpRegisterFault[])(
    "a registration with %s is refused and nothing is stored",
    async (fault) => {
      const { owner, projectId } = await newProject(`dcr-refuse-${fault}`);
      await harness.seedFakeConnection(projectId);
      fake.faults.register = fault;

      const { error } = await postConnect(owner, projectId);

      expect(error?.status).toBe(502);
      expect(error?.value).toMatchObject({
        code: "MANAGED_CONNECTION_CLIENT_CONFIGURATION",
      });
      expect(JSON.stringify(error?.value)).not.toContain(
        FAKE_REGISTRATION_CANARY,
      );
      expect(fake.callsTo("register")).toHaveLength(1);
      expect(fake.callsTo("authorize")).toHaveLength(0);
      expect(await clientRows()).toEqual([]);
    },
  );

  test("a registration that fails on the server is unavailable, not a configuration error", async () => {
    const { owner, projectId } = await newProject("dcr-register-503");
    await harness.seedFakeConnection(projectId);
    fake.faults.register = "server_error";

    const { error } = await postConnect(owner, projectId);

    expect(error?.status).toBe(502);
    expect(error?.value).toMatchObject({
      code: "MANAGED_CONNECTION_PROVIDER_UNAVAILABLE",
    });
    expect(await clientRows()).toEqual([]);
  });

  test("the registration response never reaches logs or API responses", async () => {
    const consoleLines: string[] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map(
      (method) =>
        spyOn(console, method).mockImplementation((...args: unknown[]) => {
          consoleLines.push(args.map((arg) => String(arg)).join(" "));
        }),
    );
    try {
      const connected = await harness.connectToReady("dcr-redaction");
      const refused = await newProject("dcr-redaction-refused");
      await harness.seedFakeConnection(refused.projectId);
      fake.faults.register = "client_secret";
      await getDb()
        .delete(managedOAuthClients)
        .where(eq(managedOAuthClients.issuer, fake.origin));
      const { error } = await postConnect(refused.owner, refused.projectId);

      const observed = [
        JSON.stringify(connected),
        JSON.stringify(error?.value),
        JSON.stringify(
          await harness.getConnection(
            connected.owner,
            connected.projectId,
            connected.connectionId,
          ),
        ),
        ...harness.logs,
        ...consoleLines,
      ].join("\n");

      expect(fake.callsTo("register")).toHaveLength(2);
      expect(observed).not.toContain(FAKE_REGISTRATION_CANARY);
      expect(observed).not.toContain("registration_access_token");
      expect(observed).not.toContain("registration_client_uri");
    } finally {
      for (const spy of spies) {
        spy.mockRestore();
      }
    }
  });
});
