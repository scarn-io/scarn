import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { parseUuidV7 } from "@/common/contracts/uuid-v7";
import type { ManagedOAuthAuthorizeProbe } from "@/connections/managed-mcp-connection/application/managed-oauth-authorize-probe";
import { completeManagedLoopbackAttempt } from "@/connections/managed-mcp-connection/application/complete-managed-loopback-attempt";
import { startManagedConnection } from "@/connections/managed-mcp-connection/application/start-managed-connection";
import { MANAGED_CONNECTION_PRESETS } from "@/connections/managed-mcp-connection/infra/managed-connection-presets";
import { getDb } from "@/lib/db";
import { managedOAuthClients } from "@/lib/db/schema";
import {
  createProjectSecretsTestProject,
  createProjectSecretsTestUser,
} from "tests/secrets/secret/integration/project-secret-test-support";
import {
  createManagedConnectionHarness,
  MANAGED_CONNECTION_APP_URL,
} from "./managed-connection-test-support";

const PORTLESS = "http://127.0.0.1/callback";
const FALLBACK = "http://127.0.0.1:28418/callback";
const SERVER_CALLBACK = `${MANAGED_CONNECTION_APP_URL}/api/oauth/mcp/callback`;
const cliRedirect = (port: number) =>
  `http://127.0.0.1:${String(port)}/callback`;

const params = (authorizationUrl: string) =>
  new URL(authorizationUrl).searchParams;

/**
 * Loopback sign-ins against servers that register clients dynamically
 * (decision 7): Scarn registers the portless loopback redirect once per
 * issuer and relies on port variance, and falls back to the fixed port,
 * registered once, for a server that matches redirects exactly.
 */
const dcrLoopbackHarness = (
  options: {
    strictRedirects?: boolean;
    authorizeProbe?: ManagedOAuthAuthorizeProbe;
  } = {},
) => {
  const harness = createManagedConnectionHarness({
    clientRegistration: "dcr",
    ...options,
  });
  const { fake, clock, appContext } = harness;

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

  const clientRows = async () =>
    (
      await getDb()
        .select({
          clientId: managedOAuthClients.clientId,
          redirectUri: managedOAuthClients.redirectUri,
        })
        .from(managedOAuthClients)
        .where(eq(managedOAuthClients.issuer, fake.origin))
    ).sort((a, b) => (a.redirectUri < b.redirectUri ? -1 : 1));

  const newProject = async (label: string) => {
    const owner = await createProjectSecretsTestUser(label);
    const projectId = await createProjectSecretsTestProject(
      harness.apiClient,
      owner,
    );
    await harness.seedFakeConnection(projectId);
    return { owner, projectId };
  };

  const startLoopback = async (label: string, redirectUri: string) => {
    const { owner, projectId } = await newProject(label);
    const started = await startManagedConnection(
      {
        projectId,
        definition: {
          name: "notion",
          label: MANAGED_CONNECTION_PRESETS.notion.label,
          ...harness.fakeTarget,
        },
        binding: { kind: "loopback", redirectUri },
      },
      {
        ...appContext,
        userAuthz: appContext.createUserAuthorizationService(
          parseUuidV7(owner.userId),
        ),
      },
    );
    return { owner, projectId, ...started };
  };

  /** Follows `/authorize` to the CLI's listener and completes the attempt there. */
  const completeAt = async (
    started: Awaited<ReturnType<typeof startLoopback>>,
    expectedRedirect: string,
  ) => {
    const location = await harness.authorize(started.authorizationUrl);
    expect(`${location.origin}${location.pathname}`).toBe(expectedRedirect);
    return await completeManagedLoopbackAttempt(
      {
        actorUserId: parseUuidV7(started.owner.userId),
        attemptId: started.attemptId,
        completionSecret: started.completionSecret,
        state: location.searchParams.get("state") ?? "",
        code: location.searchParams.get("code") ?? "",
        iss: location.searchParams.get("iss") ?? "",
      },
      appContext,
    );
  };

  return { harness, fake, clientRows, newProject, startLoopback, completeAt };
};

describe("loopback DCR with a server that lets the loopback port vary", () => {
  const { harness, fake, clientRows, newProject, startLoopback, completeAt } =
    dcrLoopbackHarness();

  test("two loopback connects on different ports share one portless registration", async () => {
    const first = await startLoopback("dcr-lb-first", cliRedirect(53682));
    const second = await startLoopback("dcr-lb-second", cliRedirect(53999));

    expect(fake.callsTo("register")).toHaveLength(1);
    const rows = await clientRows();
    expect(rows.map((row) => row.redirectUri)).toEqual([PORTLESS]);
    const clientId = rows[0]?.clientId ?? null;
    expect(fake.registrations.redirectUrisOf(clientId ?? "")).toEqual([
      PORTLESS,
    ]);
    expect(params(first.authorizationUrl).get("client_id")).toBe(clientId);
    expect(params(second.authorizationUrl).get("client_id")).toBe(clientId);
    expect(params(first.authorizationUrl).get("redirect_uri")).toBe(
      cliRedirect(53682),
    );
    expect(first.redirectUri).toBe(cliRedirect(53682));
    expect(second.redirectUri).toBe(cliRedirect(53999));

    expect(await completeAt(second, cliRedirect(53999))).toMatchObject({
      status: "candidate_stored",
      projectId: second.projectId,
    });
    expect(fake.callsTo("token")[0]?.params["redirect_uri"]).toBe(
      cliRedirect(53999),
    );
  });

  test("browser and loopback registrations for one issuer don't collide", async () => {
    const { owner, projectId } = await newProject("dcr-lb-browser");
    const browser = await harness.startConnect(owner, projectId);
    const loopback = await startLoopback("dcr-lb-cli", cliRedirect(53682));

    expect(fake.callsTo("register")).toHaveLength(2);
    const rows = await clientRows();
    expect(rows.map((row) => row.redirectUri)).toEqual([
      PORTLESS,
      SERVER_CALLBACK,
    ]);
    expect(params(browser.authorizationUrl).get("client_id")).toBe(
      rows[1]?.clientId ?? null,
    );
    expect(params(loopback.authorizationUrl).get("client_id")).toBe(
      rows[0]?.clientId ?? null,
    );
    expect(rows[0]?.clientId).not.toBe(rows[1]?.clientId);
  });
});

describe("loopback DCR with a server that matches redirects exactly", () => {
  const { fake, clientRows, startLoopback, completeAt } = dcrLoopbackHarness({
    strictRedirects: true,
  });

  test("a refused probe falls back to the fixed port once, and later starts skip the probe", async () => {
    const first = await startLoopback("dcr-strict-first", cliRedirect(53682));

    expect(first.redirectUri).toBe(FALLBACK);
    expect(params(first.authorizationUrl).get("redirect_uri")).toBe(FALLBACK);
    expect(fake.callsTo("register")).toHaveLength(2);
    expect(fake.callsTo("authorize")).toHaveLength(1);
    const rows = await clientRows();
    expect(rows.map((row) => row.redirectUri)).toEqual([PORTLESS, FALLBACK]);
    expect(params(first.authorizationUrl).get("client_id")).toBe(
      rows.find((row) => row.redirectUri === FALLBACK)?.clientId ?? null,
    );

    const second = await startLoopback("dcr-strict-second", cliRedirect(54001));

    expect(second.redirectUri).toBe(FALLBACK);
    expect(fake.callsTo("register")).toHaveLength(2);
    expect(fake.callsTo("authorize")).toHaveLength(1);

    expect(await completeAt(second, FALLBACK)).toMatchObject({
      status: "candidate_stored",
      projectId: second.projectId,
    });
    expect(fake.callsTo("token")[0]?.params["redirect_uri"]).toBe(FALLBACK);
  });
});

describe("loopback DCR when the authorize probe fails", () => {
  const probed: string[] = [];
  const { fake, clientRows, startLoopback } = dcrLoopbackHarness({
    strictRedirects: true,
    authorizeProbe: {
      probe: (_server, authorizationUrl) => {
        probed.push(authorizationUrl);
        return Promise.resolve("unknown");
      },
    },
  });

  test("an inconclusive probe keeps the portless client and the CLI's port", async () => {
    const started = await startLoopback(
      "dcr-probe-unknown",
      cliRedirect(53682),
    );

    expect(probed).toHaveLength(1);
    expect(params(probed[0] ?? "").get("redirect_uri")).toBe(
      cliRedirect(53682),
    );
    expect(started.redirectUri).toBe(cliRedirect(53682));
    expect(fake.callsTo("register")).toHaveLength(1);
    expect((await clientRows()).map((row) => row.redirectUri)).toEqual([
      PORTLESS,
    ]);
  });
});
