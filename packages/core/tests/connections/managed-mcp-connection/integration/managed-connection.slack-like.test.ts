/**
 * Per-connection discovery overrides (plan Phase 8, decision 10) against a
 * loopback fake shaped like Slack's MCP server: metadata only at the root,
 * naming the bare origin as the resource, endpoints on a second origin, only
 * `client_secret_post`, no `iss`, revocation, DCR or CIMD, and token errors
 * as HTTP 200 `{ ok: false }`. The CLI probes it, the start stores the
 * overrides found, and the connection signs in with a supplied client,
 * refreshes and relays.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { removeUndecryptableSigningKeys } from "@scarn/identity/testing/access-jwt-signing-keys";
import { createScarnClient } from "@scarn/sdk/client";
import type { UuidV7 } from "@/common/contracts/uuid-v7";
import type { ManagedConnectionDiscovery } from "@/connections/managed-mcp-connection/domain/managed-connection-discovery";
import { getDb } from "@/lib/db";
import { managedConnectionEvents } from "@/lib/db/schema";
import {
  createProjectSecretsTestProject,
  createProjectSecretsTestUser,
  type ProjectSecretsTestUser,
} from "tests/secrets/secret/integration/project-secret-test-support";
import { createConnectionsApi } from "../../../../../../apps/cli/src/lib/connections-api";
import { runLoopbackSignIn } from "../../../../../../apps/cli/src/lib/connections-loopback";
import { bindLoopbackCallback } from "../../../../../../apps/cli/src/lib/loopback-callback";
import { noopBaseReporter } from "../../../../../../apps/cli/src/lib/reporter-types";
import { createManagedConnectionHarness } from "./managed-connection-test-support";
import { createRelayTestClient, rpc } from "./managed-mcp-relay-test-support";

const HOUR_MS = 60 * 60 * 1000;
const CLIENT_ID = "slack-config-client";

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

const REDIRECT_URI = `http://localhost:${String(freePort())}/callback`;

const eventsOf = async (connectionId: string) =>
  await getDb()
    .select({
      type: managedConnectionEvents.type,
      reasonCode: managedConnectionEvents.reasonCode,
    })
    .from(managedConnectionEvents)
    .where(eq(managedConnectionEvents.connectionId, connectionId));

describe("a Slack-like custom server", () => {
  const harness = createManagedConnectionHarness({
    slackLike: true,
    preset: null,
    suppliedClient: { clientId: CLIENT_ID, redirectUri: REDIRECT_URI },
  });
  const { fake, clock, app, apiClient, appContext } = harness;
  const { launchIn, relay } = createRelayTestClient(harness);
  const client = { clientId: CLIENT_ID, redirectUri: REDIRECT_URI };

  afterEach(async () => {
    await harness.settleBackgroundTasks();
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
    return createConnectionsApi(
      createScarnClient("http://localhost", {
        fetch: (input, init) => {
          const request = new Request(input, init);
          request.headers.set("authorization", `Bearer ${token}`);
          return app.handle(request);
        },
      }),
    );
  };

  /** Probes the fake and signs in to it from the CLI as connection "slack". */
  const connect = async (label: string) => {
    const owner = await createProjectSecretsTestUser(label);
    const projectId = await createProjectSecretsTestProject(apiClient, owner);
    const api = await cliApiFor(owner);
    const probed = await api.probe({
      projectId,
      resource: fake.resource,
      client,
    });
    const outcome = await runLoopbackSignIn({
      projectId,
      projectRef: "owner/project",
      target: {
        kind: "custom",
        custom: {
          name: "slack",
          resource: fake.resource,
          client,
          confirmIssuerOrigin: probed.issuerOrigin,
        },
        suppliedRedirectUri: REDIRECT_URI,
      },
      yes: true,
      noBrowser: false,
      reporter: noopBaseReporter,
      ports: {
        api,
        bindListener: bindLoopbackCallback,
        openBrowser: async (authorizationUrl) => {
          await fetch(await harness.authorize(authorizationUrl));
        },
        isTty: true,
      },
    });
    return { owner, projectId, probed, outcome };
  };

  const storedSlack = async (projectId: UuidV7) => {
    const stored = await appContext.managedConnectionRepo.loadByName(
      projectId,
      "slack",
    );
    if (!stored) {
      throw new Error("expected the slack connection");
    }
    return stored;
  };

  const expectedOverrides = (): ManagedConnectionDiscovery => ({
    resourceMetadataUrl: `${fake.origin}/.well-known/oauth-protected-resource`,
    advertisedResource: fake.origin,
    endpointOrigins: [fake.endpointOrigin],
    tokenErrors: "slack",
  });

  test("is probed with every override, connects, refreshes and relays", async () => {
    const { owner, projectId, probed, outcome } = await connect("slack-like");

    expect(probed).toEqual({
      resource: fake.resource,
      issuerOrigin: fake.origin,
      endpointOrigins: [fake.endpointOrigin],
      clientRegistration: "supplied",
      supports: { cimd: false, dcr: false },
      overrides: expectedOverrides(),
    });
    expect(outcome.kind).toBe("confirmed");
    expect(outcome.connection).toMatchObject({
      name: "slack",
      resource: fake.resource,
      state: "ready",
    });
    const stored = await storedSlack(projectId);
    expect(stored.server).toEqual({
      resource: fake.resource,
      issuerOrigin: fake.origin,
      discovery: expectedOverrides(),
      clientRegistration: "supplied",
      suppliedClientId: CLIENT_ID,
      suppliedRedirectUri: REDIRECT_URI,
    });
    expect(fake.callsTo("authorize")[0]?.params["resource"]).toBe(fake.origin);
    expect(fake.callsTo("token")[0]?.params["resource"]).toBe(fake.origin);

    clock.advance(HOUR_MS);
    const launched = await launchIn(owner, projectId, ["slack"], {
      slack: fake.resource,
    });
    const entry = launched.entries["slack"];
    if (!entry) {
      throw new Error("expected a slack entry");
    }
    const called = await relay(entry, {
      body: rpc(1, "tools/call", { name: "notion-tool-0-0", arguments: {} }),
    });

    expect(called.status).toBe(200);
    await called.text();
    expect(fake.refreshCount).toBe(1);
    expect(fake.callsTo("refresh")[0]?.params["resource"]).toBe(fake.origin);
    expect(fake.mcp.effectCount("notion-tool-0-0")).toBe(1);
  });

  test("an invalid_refresh_token answered with 200 ok:false needs a reconnect", async () => {
    const { owner, projectId } = await connect("slack-like-refresh");
    const { id: connectionId } = await storedSlack(projectId);
    clock.advance(HOUR_MS);
    const launched = await launchIn(owner, projectId, ["slack"], {
      slack: fake.resource,
    });
    const entry = launched.entries["slack"];
    if (!entry) {
      throw new Error("expected a slack entry");
    }
    fake.faults.refresh = "invalid_grant";

    const called = await relay(entry, {
      body: rpc(1, "tools/call", { name: "notion-tool-0-0", arguments: {} }),
    });
    await called.text();

    expect(called.status).not.toBe(200);
    expect(fake.refreshCount).toBe(1);
    expect(await eventsOf(connectionId)).toContainEqual({
      type: "refresh_failed",
      reasonCode: "refresh_rejected",
    });
    expect(
      await harness.getConnection(owner, projectId, connectionId),
    ).toMatchObject({ state: "reconnect_required" });
  });

  /** The provider for the fake's server with every override but `drop`. */
  const providerWithout = (drop: keyof ManagedConnectionDiscovery | null) => {
    const discovery = Object.fromEntries(
      Object.entries(expectedOverrides()).filter(([key]) => key !== drop),
    ) as ManagedConnectionDiscovery;
    return appContext.managedOAuthProviders.for({
      server: {
        resource: fake.resource,
        issuerOrigin: fake.origin,
        discovery,
        clientRegistration: "supplied",
        suppliedClientId: CLIENT_ID,
        suppliedRedirectUri: REDIRECT_URI,
      },
      preset: null,
    });
  };

  test("with every override discovery passes", async () => {
    expect(await providerWithout(null).discover()).toMatchObject({
      resource: fake.origin,
      tokenEndpoint: `${fake.endpointOrigin}/token`,
    });
  });

  test.each([
    ["resourceMetadataUrl", "metadata request returned 404"],
    ["advertisedResource", "names a different resource"],
    ["endpointOrigins", "authorization_endpoint is not on the allowed origin"],
  ] as const)(
    "without %s the server fails discovery",
    async (drop, message) => {
      let failed = "";
      try {
        await providerWithout(drop).discover();
      } catch (error) {
        failed = String(error);
      }

      expect(failed).toContain(message);
    },
  );

  test("without endpointOrigins no request reaches the second origin", async () => {
    await providerWithout("endpointOrigins")
      .discover()
      .catch(() => null);

    expect(fake.calls.map((call) => call.endpoint)).toEqual([
      "protected_resource_metadata",
      "authorization_server_metadata",
    ]);
    expect(fake.callsTo("token")).toHaveLength(0);
  });
});
