/**
 * Custom MCP servers from the user's MCP config (plan Phase 7, decision 12):
 * the CLI probes the URL, shows the issuer, and starts the connection with
 * the issuer origin the user confirmed. Nothing is stored until a start
 * whose fresh probe still finds that issuer.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { removeUndecryptableSigningKeys } from "@scarn/identity/testing/access-jwt-signing-keys";
import type { UuidV7 } from "@/common/contracts/uuid-v7";
import { FakeMcpOAuth } from "tests/connections/support/fake-mcp-oauth";
import {
  createProjectSecretsTestProject,
  createProjectSecretsTestUser,
  type ProjectSecretsTestUser,
} from "tests/secrets/secret/integration/project-secret-test-support";
import { unwrapAsync } from "tests/utils";
import { createManagedConnectionHarness } from "./managed-connection-test-support";

const LOOPBACK_REDIRECT = "http://127.0.0.1:53682/callback";

describe("custom managed connections", () => {
  const otherIssuer = new FakeMcpOAuth().start();
  const harness = createManagedConnectionHarness({
    loopbackOrigins: [otherIssuer.origin],
  });
  const { fake, clock, app, apiClient, appContext, connections } = harness;

  afterEach(() => {
    fake.reset();
    otherIssuer.reset();
    clock.reset();
  });

  afterAll(async () => {
    await fake.stop();
    await otherIssuer.stop();
  });

  const accessHeadersOf = async (user: ProjectSecretsTestUser) => {
    await removeUndecryptableSigningKeys();
    const response = await app.handle(
      new Request("http://localhost/api/auth/token", {
        headers: user.authHeaders,
      }),
    );
    expect(response.status).toBe(200);
    const { token } = (await response.json()) as { token: string };
    return { authorization: `Bearer ${token}` };
  };

  const setUp = async (label: string) => {
    const owner = await createProjectSecretsTestUser(label);
    const projectId = await createProjectSecretsTestProject(apiClient, owner);
    return { projectId, headers: await accessHeadersOf(owner) };
  };

  const probe = (
    projectId: UuidV7,
    headers: Record<string, string>,
    resource = fake.resource,
  ) => connections(projectId).probe.post({ resource }, { headers });

  const startCustom = (
    projectId: UuidV7,
    headers: Record<string, string>,
    confirmIssuerOrigin: string,
  ) =>
    connections(projectId).loopback.post(
      {
        custom: {
          name: "linear",
          resource: fake.resource,
          confirmIssuerOrigin,
        },
        redirectUri: LOOPBACK_REDIRECT,
      },
      { headers },
    );

  const advertiseNoClientRegistration = () => {
    fake.authorizationServerOverrides = {
      client_id_metadata_document_supported: false,
      registration_endpoint: undefined,
    };
  };

  test("a server from the MCP config is probed, confirmed, created and signed in to", async () => {
    const { projectId, headers } = await setUp("custom-create");

    const probed = await unwrapAsync(probe(projectId, headers));
    expect(probed).toEqual({
      resource: fake.resource,
      issuerOrigin: fake.origin,
      endpointOrigins: [fake.origin],
      clientRegistration: "cimd",
      supports: { cimd: true, dcr: true },
      overrides: {},
    });
    const challenge = fake.mcp.calls[0];
    expect(challenge?.rpcMethod).toBe("initialize");
    expect(challenge?.authorization).toBeNull();
    expect(
      await appContext.managedConnectionRepo.loadByName(projectId, "linear"),
    ).toBeNull();

    const started = await unwrapAsync(
      startCustom(projectId, headers, probed.issuerOrigin),
    );
    const location = await harness.authorize(started.authorizationUrl);
    const completed = await unwrapAsync(
      apiClient.api["mcp-connection-attempts"]({
        attemptId: started.attemptId,
      }).complete.post(
        {
          completionSecret: started.completionSecret,
          state: location.searchParams.get("state") ?? "",
          code: location.searchParams.get("code") ?? "",
          iss: location.searchParams.get("iss") ?? "",
        },
        { headers },
      ),
    );
    expect(completed).toMatchObject({
      id: started.connectionId,
      name: "linear",
      label: "linear",
      preset: null,
      resource: fake.resource,
      suppliedClient: null,
      state: "awaiting_confirmation",
    });
  });

  test("an issuer that changed between the probe and the start is refused, storing nothing", async () => {
    const { projectId, headers } = await setUp("custom-issuer-changed");
    const probed = await unwrapAsync(probe(projectId, headers));

    fake.protectedResourceOverrides = {
      authorization_servers: [otherIssuer.origin],
    };
    const response = await startCustom(projectId, headers, probed.issuerOrigin);

    expect(response.status).toBe(409);
    expect(response.error?.value).toMatchObject({
      code: "MANAGED_CONNECTION_ISSUER_CHANGED",
      meta: { issuerOrigin: otherIssuer.origin },
    });
    expect(
      await appContext.managedConnectionRepo.loadByName(projectId, "linear"),
    ).toBeNull();
    expect(fake.callsTo("register")).toHaveLength(0);
  });

  test("a server with neither CIMD nor DCR needs a client from the MCP config", async () => {
    const { projectId, headers } = await setUp("custom-client-required");
    advertiseNoClientRegistration();

    const probed = await probe(projectId, headers);
    expect(probed.status).toBe(422);
    expect(probed.error?.value).toMatchObject({
      code: "MANAGED_CONNECTION_CLIENT_REQUIRED",
    });

    const started = await startCustom(projectId, headers, fake.origin);
    expect(started.status).toBe(422);
    expect(started.error?.value).toMatchObject({
      code: "MANAGED_CONNECTION_CLIENT_REQUIRED",
    });
    expect(
      await appContext.managedConnectionRepo.loadByName(projectId, "linear"),
    ).toBeNull();
  });

  test("a supplied client is used as is, and its redirect is the only one a start accepts", async () => {
    const { projectId, headers } = await setUp("custom-supplied");
    advertiseNoClientRegistration();
    const client = {
      clientId: "config-client",
      redirectUri: "http://localhost:3118/callback",
    };

    const probed = await unwrapAsync(
      connections(projectId).probe.post(
        { resource: fake.resource, client },
        { headers },
      ),
    );
    expect(probed).toMatchObject({
      clientRegistration: "supplied",
      supports: { cimd: false, dcr: false },
    });

    const custom = {
      name: "linear",
      label: "Linear",
      resource: fake.resource,
      client,
      confirmIssuerOrigin: probed.issuerOrigin,
    };
    const elsewhere = await connections(projectId).loopback.post(
      { custom, redirectUri: LOOPBACK_REDIRECT },
      { headers },
    );
    expect(elsewhere.status).toBe(422);
    expect(elsewhere.error?.value).toMatchObject({
      code: "MANAGED_CONNECTION_REDIRECT_INVALID",
    });
    expect(
      await appContext.managedConnectionRepo.loadByName(projectId, "linear"),
    ).toBeNull();

    const started = await unwrapAsync(
      connections(projectId).loopback.post(
        { custom, redirectUri: client.redirectUri },
        { headers },
      ),
    );
    expect(started.redirectUri).toBe(client.redirectUri);
    const stored = await appContext.managedConnectionRepo.loadByName(
      projectId,
      "linear",
    );
    expect(stored?.label).toBe("Linear");
    expect(stored?.server).toEqual({
      resource: fake.resource,
      issuerOrigin: fake.origin,
      clientRegistration: "supplied",
      suppliedClientId: client.clientId,
      suppliedRedirectUri: client.redirectUri,
    });
  });

  test("a URL that doesn't ask for OAuth, or isn't https, is refused", async () => {
    const { projectId, headers } = await setUp("custom-invalid");

    const notOAuth = await probe(projectId, headers, `${fake.origin}/other`);
    expect(notOAuth.status).toBe(422);
    expect(notOAuth.error?.value).toMatchObject({
      code: "MANAGED_CONNECTION_DISCOVERY_FAILED",
    });

    const plainHttp = await probe(projectId, headers, "http://example.com/mcp");
    expect(plainHttp.status).toBe(422);
    expect(plainHttp.error?.value).toMatchObject({
      code: "MANAGED_CONNECTION_RESOURCE_INVALID",
    });
  });
});
