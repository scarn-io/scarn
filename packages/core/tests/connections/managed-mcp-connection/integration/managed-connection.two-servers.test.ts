import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { DrizzleAuthSessionRepo } from "@scarn/identity";
import { parseUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import { acquireManagedAccessToken } from "@/connections/managed-mcp-connection/application/acquire-managed-access-token";
import { listManagedMcpTools } from "@/connections/managed-mcp-connection/application/list-managed-mcp-tools";
import { startManagedConnection } from "@/connections/managed-mcp-connection/application/start-managed-connection";
import type { ManagedConnectionDefinition } from "@/connections/managed-mcp-connection/domain/managed-connection-server";
import { getDb } from "@/lib/db";
import { managedOAuthGrants } from "@/lib/db/schema";
import { CoreError } from "@/lib/errors";
import {
  FAKE_MCP_NO_PRESET,
  FakeMcpOAuth,
} from "tests/connections/support/fake-mcp-oauth";
import {
  createProjectSecretsTestProject,
  createProjectSecretsTestUser,
  type ProjectSecretsTestUser,
} from "tests/secrets/secret/integration/project-secret-test-support";
import { unwrapAsync } from "tests/utils";
import { createManagedConnectionHarness } from "./managed-connection-test-support";
import {
  createRelayTestClient,
  RELAY_PROTOCOL_VERSION,
  rpc,
} from "./managed-mcp-relay-test-support";

const HOUR_MS = 60 * 60 * 1000;

const failureOf = async (promise: Promise<unknown>): Promise<CoreError> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CoreError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected the call to fail");
};

/**
 * Two connections in one project, each to its own loopback fake: `notion`
 * from the Notion preset and `acme-docs` with no preset. Every outbound call
 * made for a connection (refresh, relay, tool listing) reaches only that
 * connection's fake, and a grant whose stored `resource` isn't its
 * connection's is refused before anything is sent.
 */
describe("managed connections to two servers", () => {
  const appRef: { current: ((request: Request) => Promise<Response>) | null } =
    { current: null };
  const acme = new FakeMcpOAuth({
    ...FAKE_MCP_NO_PRESET,
    toolPrefix: "acme-tool",
    fetchClientMetadata: (url) =>
      appRef.current?.(new Request(url)) ??
      Promise.resolve(new Response(null, { status: 503 })),
  }).start();
  const harness = createManagedConnectionHarness({
    loopbackOrigins: [acme.origin],
  });
  appRef.current = (request) => harness.app.handle(request);
  const { fake: notion, clock, appContext, origin } = harness;
  const { launchIn, relay } = createRelayTestClient(harness);

  const acmeDefinition = (): ManagedConnectionDefinition => ({
    name: "acme-docs",
    label: "Acme Docs",
    preset: null,
    server: {
      resource: acme.resource,
      issuerOrigin: acme.origin,
      clientRegistration: "cimd",
    },
  });

  afterEach(async () => {
    await harness.settleBackgroundTasks();
    notion.reset();
    acme.reset();
    clock.reset();
  });

  afterAll(async () => {
    await notion.stop();
    await acme.stop();
  });

  const connectAcme = async (
    owner: ProjectSecretsTestUser,
    projectId: UuidV7,
  ): Promise<UuidV7> => {
    const session = await new DrizzleAuthSessionRepo().loadByToken(
      owner.sessionToken,
    );
    if (!session) {
      throw new Error("expected the owner's session");
    }
    const started = await startManagedConnection(
      {
        projectId,
        definition: acmeDefinition(),
        binding: { kind: "browser", sessionId: session.id },
      },
      {
        ...appContext,
        userAuthz: appContext.createUserAuthorizationService(
          parseUuidV7(owner.userId),
        ),
      },
    );
    const callbackUrl = await harness.authorize(started.authorizationUrl);
    const { location } = await harness.callback(callbackUrl, owner.authHeaders);
    expect(location.searchParams.get("error")).toBeNull();
    const pending = await harness.getConnection(
      owner,
      projectId,
      started.connectionId,
    );
    const candidate = pending.candidate;
    if (!candidate) {
      throw new Error("expected a candidate");
    }
    await unwrapAsync(
      harness
        .connections(projectId)({ connectionId: started.connectionId })
        .candidate.confirm.post(
          {
            candidateId: candidate.id,
            fingerprint: candidate.fingerprint,
            expectedVersion: pending.version,
          },
          { headers: { ...owner.authHeaders, origin } },
        ),
    );
    return parseUuidV7(started.connectionId);
  };

  /** One project with both connections ready, and nothing recorded by either fake yet. */
  const bothReady = async (label: string) => {
    const owner = await createProjectSecretsTestUser(label);
    const projectId = await createProjectSecretsTestProject(
      harness.apiClient,
      owner,
    );
    const started = await harness.startConnect(owner, projectId);
    const callbackUrl = await harness.authorize(started.authorizationUrl);
    await harness.callback(callbackUrl, owner.authHeaders);
    const pending = await harness.getConnection(
      owner,
      projectId,
      started.connectionId,
    );
    if (!pending.candidate) {
      throw new Error("expected a notion candidate");
    }
    await unwrapAsync(
      harness
        .connections(projectId)({ connectionId: started.connectionId })
        .candidate.confirm.post(
          {
            candidateId: pending.candidate.id,
            fingerprint: pending.candidate.fingerprint,
            expectedVersion: pending.version,
          },
          { headers: { ...owner.authHeaders, origin } },
        ),
    );
    const acmeConnectionId = await connectAcme(owner, projectId);
    notion.calls.length = 0;
    acme.calls.length = 0;
    notion.mcp.calls.length = 0;
    acme.mcp.calls.length = 0;
    return {
      owner,
      projectId,
      notion: { projectId, connectionId: parseUuidV7(started.connectionId) },
      acme: { projectId, connectionId: acmeConnectionId },
    };
  };

  const initializeBody = rpc(1, "initialize", {
    protocolVersion: RELAY_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "two-servers-test", version: "0" },
  });

  test("each connection's refresh goes only to its own server", async () => {
    const connected = await bothReady("two-refresh");
    clock.advance(HOUR_MS);

    const notionToken = await acquireManagedAccessToken(
      connected.notion,
      appContext,
    );
    expect(notion.refreshCount).toBe(1);
    expect(acme.calls).toHaveLength(0);

    const acmeToken = await acquireManagedAccessToken(
      connected.acme,
      appContext,
    );
    expect(acme.refreshCount).toBe(1);
    expect(notion.refreshCount).toBe(1);
    expect(notionToken.server.resource).toBe(notion.resource);
    expect(acmeToken.server.resource).toBe(acme.resource);
  });

  test("each connection's tools are listed from its own server", async () => {
    const connected = await bothReady("two-tools");

    const notionTools = await listManagedMcpTools(connected.notion, appContext);
    expect(acme.mcp.calls).toHaveLength(0);
    const acmeTools = await listManagedMcpTools(connected.acme, appContext);

    expect(notionTools.map((tool) => tool.name)).toEqual([
      "notion-tool-0-0",
      "notion-tool-0-1",
    ]);
    expect(acmeTools.map((tool) => tool.name)).toEqual([
      "acme-tool-0-0",
      "acme-tool-0-1",
    ]);
    expect(notion.mcp.callsTo("tools/list")).toHaveLength(1);
    expect(acme.mcp.callsTo("tools/list")).toHaveLength(1);
  });

  test("each launch entry relays only to its connection's server", async () => {
    const connected = await bothReady("two-relay");
    const launched = await launchIn(
      connected.owner,
      connected.projectId,
      ["notion", "acme-docs"],
      { "acme-docs": acme.resource },
    );
    const notionEntry = launched.entries["notion"];
    const acmeEntry = launched.entries["acme-docs"];
    if (!notionEntry || !acmeEntry) {
      throw new Error("expected both entries");
    }

    const toNotion = await relay(notionEntry, { body: initializeBody });
    expect(toNotion.status).toBe(200);
    await toNotion.text();
    expect(notion.mcp.callsTo("initialize")).toHaveLength(1);
    expect(acme.mcp.calls).toHaveLength(0);

    const toAcme = await relay(acmeEntry, { body: initializeBody });
    expect(toAcme.status).toBe(200);
    await toAcme.text();
    expect(acme.mcp.callsTo("initialize")).toHaveLength(1);
    expect(notion.mcp.callsTo("initialize")).toHaveLength(1);
  });

  test("a grant whose resource isn't its connection's is refused by the relay and the tool lister", async () => {
    const connected = await bothReady("two-mismatch");
    const launched = await launchIn(
      connected.owner,
      connected.projectId,
      ["acme-docs"],
      { "acme-docs": acme.resource },
    );
    const acmeEntry = launched.entries["acme-docs"];
    if (!acmeEntry) {
      throw new Error("expected the acme-docs entry");
    }
    await getDb()
      .update(managedOAuthGrants)
      .set({ resource: notion.resource })
      .where(eq(managedOAuthGrants.connectionId, connected.acme.connectionId));

    const relayed = await relay(acmeEntry, { body: initializeBody });
    const listed = await failureOf(
      listManagedMcpTools(connected.acme, appContext),
    );

    expect(relayed.status).toBe(500);
    expect(listed.code).toBe("MANAGED_CONNECTION_GRANT_MISMATCH");
    expect(notion.mcp.calls).toHaveLength(0);
    expect(acme.mcp.calls).toHaveLength(0);
    expect(notion.calls).toHaveLength(0);
    expect(acme.calls).toHaveLength(0);
  });
});
