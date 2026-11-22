/**
 * Connections that sign in as a client the user supplied (plan Phase 6,
 * decisions 5 and 13): the fake knows only that client and its one fixed
 * loopback redirect, advertises neither CIMD nor DCR, and the CLI's real
 * loopback flow binds exactly that redirect. Browser starts are refused.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { removeUndecryptableSigningKeys } from "@scarn/identity/testing/access-jwt-signing-keys";
import { createScarnClient } from "@scarn/sdk/client";
import { parseUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import { acquireManagedAccessToken } from "@/connections/managed-mcp-connection/application/acquire-managed-access-token";
import { startManagedConnection } from "@/connections/managed-mcp-connection/application/start-managed-connection";
import { startManagedReconnect } from "@/connections/managed-mcp-connection/application/start-managed-reconnect";
import { MANAGED_CONNECTION_PRESETS } from "@/connections/managed-mcp-connection/infra/managed-connection-presets";
import { getDb } from "@/lib/db";
import { managedConnectionEvents } from "@/lib/db/schema";
import {
  createProjectSecretsTestProject,
  createProjectSecretsTestUser,
  type ProjectSecretsTestUser,
} from "tests/secrets/secret/integration/project-secret-test-support";
import { createConnectionsApi } from "../../../../../../apps/cli/src/lib/connections-api";
import { runLoopbackSignIn } from "../../../../../../apps/cli/src/lib/connections-loopback";
import {
  bindLoopbackCallback,
  type BindLoopbackCallbackInput,
} from "../../../../../../apps/cli/src/lib/loopback-callback";
import { noopBaseReporter } from "../../../../../../apps/cli/src/lib/reporter-types";
import { createManagedConnectionHarness } from "./managed-connection-test-support";

const HOUR_MS = 60 * 60 * 1000;

const freePort = (): number => {
  const probe = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(null),
  });
  const port = probe.port ?? 0;
  void probe.stop(true);
  return port;
};

const SUPPLIED_CLIENT_ID = "supplied-client-1234";
const SUPPLIED_PORT = freePort();
const SUPPLIED_REDIRECT = `http://localhost:${String(SUPPLIED_PORT)}/callback`;

const refusalOf = async (started: Promise<object>) => {
  try {
    await started;
    return null;
  } catch (error) {
    return error;
  }
};

const eventsOf = async (connectionId: string) =>
  await getDb()
    .select({
      type: managedConnectionEvents.type,
      reasonCode: managedConnectionEvents.reasonCode,
    })
    .from(managedConnectionEvents)
    .where(eq(managedConnectionEvents.connectionId, connectionId));

describe("a connection with a supplied client", () => {
  const harness = createManagedConnectionHarness({
    suppliedClient: {
      clientId: SUPPLIED_CLIENT_ID,
      redirectUri: SUPPLIED_REDIRECT,
    },
  });
  const { fake, clock, app, apiClient, appContext, origin } = harness;

  afterEach(() => {
    fake.reset();
    clock.reset();
  });

  afterAll(async () => {
    await fake.stop();
  });

  const cliApiFor = async (user: ProjectSecretsTestUser) => {
    await removeUndecryptableSigningKeys();
    const minted = await app.handle(
      new Request("http://localhost/api/auth/token", {
        headers: user.authHeaders,
      }),
    );
    const { token } = (await minted.json()) as { token: string };
    const client = createScarnClient("http://localhost", {
      fetch: (input, init) => {
        const request = new Request(input, init);
        request.headers.set("authorization", `Bearer ${token}`);
        return app.handle(request);
      },
    });
    return createConnectionsApi(client);
  };

  const setUp = async (label: string) => {
    const owner = await createProjectSecretsTestUser(label);
    const projectId = await createProjectSecretsTestProject(apiClient, owner);
    await harness.seedFakeConnection(projectId);
    const seeded = await appContext.managedConnectionRepo.loadByName(
      projectId,
      "notion",
    );
    if (!seeded) {
      throw new Error("expected the seeded connection");
    }
    return { owner, projectId, connectionId: seeded.id };
  };

  const depsFor = (user: ProjectSecretsTestUser) => ({
    ...appContext,
    userAuthz: appContext.createUserAuthorizationService(
      parseUuidV7(user.userId),
    ),
  });

  /** Signs in through the CLI's real loopback flow, recording what it binds. */
  const signIn = async (
    user: ProjectSecretsTestUser,
    projectId: UuidV7,
    binds: BindLoopbackCallbackInput[] = [],
  ) =>
    await runLoopbackSignIn({
      projectId,
      projectRef: "owner/project",
      target: {
        kind: "connect",
        preset: "notion",
        name: "notion",
        suppliedRedirectUri: SUPPLIED_REDIRECT,
      },
      yes: true,
      noBrowser: false,
      reporter: noopBaseReporter,
      ports: {
        api: await cliApiFor(user),
        bindListener: (input) => {
          binds.push(input);
          return bindLoopbackCallback(input);
        },
        openBrowser: async (authorizationUrl) => {
          await fetch(await harness.authorize(authorizationUrl));
        },
        isTty: true,
      },
    });

  test("signs in from the CLI on the client's fixed redirect, with no CIMD or DCR", async () => {
    const { owner, projectId } = await setUp("supplied-connect");
    const binds: BindLoopbackCallbackInput[] = [];

    const outcome = await signIn(owner, projectId, binds);

    expect(outcome.kind).toBe("confirmed");
    expect(outcome.connection).toMatchObject({
      state: "ready",
      suppliedClient: {
        clientId: SUPPLIED_CLIENT_ID,
        redirectUri: SUPPLIED_REDIRECT,
      },
    });
    expect(binds).toEqual([
      {
        host: "localhost",
        port: SUPPLIED_PORT,
        path: "/callback",
        portFixedBy: "client",
      },
    ]);
    const authorize = fake.callsTo("authorize")[0]?.params;
    expect(authorize?.["client_id"]).toBe(SUPPLIED_CLIENT_ID);
    expect(authorize?.["redirect_uri"]).toBe(SUPPLIED_REDIRECT);
    const token = fake.callsTo("token")[0]?.params;
    expect(token?.["client_id"]).toBe(SUPPLIED_CLIENT_ID);
    expect(token?.["redirect_uri"]).toBe(SUPPLIED_REDIRECT);
    expect(token?.["client_secret"]).toBeUndefined();
    expect(fake.callsTo("register")).toHaveLength(0);
  });

  test.each([
    ["another port", "http://localhost:53682/callback"],
    ["another host", SUPPLIED_REDIRECT.replace("localhost", "127.0.0.1")],
    ["another path", SUPPLIED_REDIRECT.replace("/callback", "/cb")],
  ])("a loopback start on %s is refused", async (_label, redirectUri) => {
    const { owner, projectId, connectionId } = await setUp(
      `supplied-mismatch-${String(redirectUri.length)}`,
    );

    const connect = await refusalOf(
      startManagedConnection(
        {
          projectId,
          definition: {
            name: "notion",
            label: MANAGED_CONNECTION_PRESETS.notion.label,
            ...harness.fakeTarget,
          },
          binding: { kind: "loopback", redirectUri },
        },
        depsFor(owner),
      ),
    );
    const reconnect = await refusalOf(
      startManagedReconnect(
        { projectId, connectionId, binding: { kind: "loopback", redirectUri } },
        depsFor(owner),
      ),
    );

    for (const refusal of [connect, reconnect]) {
      expect(refusal).toMatchObject({
        code: "MANAGED_CONNECTION_REDIRECT_INVALID",
        status: 422,
      });
    }
    expect(fake.calls).toHaveLength(0);
  });

  test("browser connect and reconnect are 409 with the CLI command to run", async () => {
    const { owner, projectId, connectionId } = await setUp("supplied-browser");
    const headers = { ...owner.authHeaders, origin };

    const connect = await harness
      .connections(projectId)
      .post({ preset: "notion" }, { headers });
    const reconnect = await harness
      .connections(projectId)({ connectionId })
      .reconnect.post(undefined, { headers });

    expect(connect.error?.status).toBe(409);
    expect(connect.error?.value).toMatchObject({
      code: "MANAGED_CONNECTION_REQUIRES_CLI",
      meta: { command: "scarn connections connect notion" },
    });
    expect(reconnect.error?.status).toBe(409);
    expect(reconnect.error?.value).toMatchObject({
      code: "MANAGED_CONNECTION_REQUIRES_CLI",
      meta: { command: "scarn connections reconnect notion" },
    });
    expect(fake.calls).toHaveLength(0);
  });

  test("invalid_client at refresh moves the connection to reconnect_required", async () => {
    const { owner, projectId, connectionId } = await setUp("supplied-refresh");
    await signIn(owner, projectId);
    clock.advance(HOUR_MS);
    fake.faults.refresh = "invalid_client";

    const failed = await refusalOf(
      acquireManagedAccessToken({ projectId, connectionId }, appContext),
    );

    expect(failed).toMatchObject({
      code: "MANAGED_CONNECTION_NOT_READY",
      meta: { state: "reconnect_required", reasonCode: "refresh_failed" },
    });
    expect(fake.refreshCount).toBe(1);
    expect(fake.callsTo("refresh")[0]?.params["client_id"]).toBe(
      SUPPLIED_CLIENT_ID,
    );
    expect(await eventsOf(connectionId)).toContainEqual({
      type: "refresh_failed",
      reasonCode: "refresh_client_rejected",
    });
    const after = await harness.getConnection(owner, projectId, connectionId);
    expect(after).toMatchObject({
      state: "reconnect_required",
      suppliedClient: {
        clientId: SUPPLIED_CLIENT_ID,
        redirectUri: SUPPLIED_REDIRECT,
      },
    });
  });
});
