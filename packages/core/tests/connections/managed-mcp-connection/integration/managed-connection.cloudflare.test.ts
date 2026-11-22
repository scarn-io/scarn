import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { UuidV7 } from "@/common/contracts/uuid-v7";
import { getDb } from "@/lib/db";
import { managedOAuthClients } from "@/lib/db/schema";
import { FakeMcpOAuth } from "tests/connections/support/fake-mcp-oauth";
import type { ProjectSecretsTestUser } from "tests/secrets/secret/integration/project-secret-test-support";
import { unwrapAsync } from "tests/utils";
import { createManagedConnectionHarness } from "./managed-connection-test-support";
import { createRelayTestClient, rpc } from "./managed-mcp-relay-test-support";

const HOUR_MS = 60 * 60 * 1000;
const PRESET = "cloudflare-observability";

/**
 * The `cloudflare-observability` preset against a loopback fake shaped like
 * Cloudflare's metadata (fetched 2026-11-19): DCR without CIMD, `iss` on the
 * callback, revocation at `/token`, and no identity in the token response.
 * The harness's `notion` connection runs alongside it in the same project.
 */
describe("managed connection from the Cloudflare Observability preset", () => {
  const cloudflare = new FakeMcpOAuth({
    clientRegistration: "dcr",
    identityShape: "none",
    toolPrefix: "cf-tool",
  }).start();
  const harness = createManagedConnectionHarness({
    loopbackOrigins: [cloudflare.origin],
    presetFakes: { [PRESET]: cloudflare },
  });
  const { fake: notion, clock, app, origin } = harness;
  const { launchIn, relay } = createRelayTestClient(harness);

  afterEach(async () => {
    await harness.settleBackgroundTasks();
    notion.reset();
    cloudflare.reset();
    clock.reset();
    await getDb()
      .delete(managedOAuthClients)
      .where(eq(managedOAuthClients.issuer, cloudflare.origin));
  });

  afterAll(async () => {
    await notion.stop();
    await cloudflare.stop();
  });

  const connectCloudflareToCandidate = async (
    owner: ProjectSecretsTestUser,
    projectId: UuidV7,
  ) => {
    const started = await unwrapAsync(
      harness
        .connections(projectId)
        .post(
          { preset: PRESET },
          { headers: { ...owner.authHeaders, origin } },
        ),
    );
    const callbackUrl = await harness.authorize(started.authorizationUrl);
    const { location } = await harness.callback(callbackUrl, owner.authHeaders);
    expect(location.searchParams.get("error")).toBeNull();
    const pending = await harness.getConnection(
      owner,
      projectId,
      started.connectionId,
    );
    if (!pending.candidate) {
      throw new Error("expected a candidate");
    }
    return {
      connectionId: started.connectionId,
      pending,
      candidate: pending.candidate,
    };
  };

  const confirm = async (
    owner: ProjectSecretsTestUser,
    projectId: UuidV7,
    started: Awaited<ReturnType<typeof connectCloudflareToCandidate>>,
  ) =>
    await unwrapAsync(
      harness
        .connections(projectId)({ connectionId: started.connectionId })
        .candidate.confirm.post(
          {
            candidateId: started.candidate.id,
            fingerprint: started.candidate.fingerprint,
            expectedVersion: started.pending.version,
          },
          { headers: { ...owner.authHeaders, origin } },
        ),
    );

  const toolNames = async (
    owner: ProjectSecretsTestUser,
    projectId: UuidV7,
    connectionId: string,
  ) => {
    const response = await app.handle(
      new Request(
        `http://localhost/api/projects/${projectId}/mcp-connections/${connectionId}/tools`,
        { headers: owner.authHeaders },
      ),
    );
    const body = (await response.json()) as {
      tools?: { name: string }[];
      code?: string;
    };
    return {
      status: response.status,
      names: body.tools?.map((tool) => tool.name) ?? [],
      code: body.code,
    };
  };

  test("connects without an identity, refreshes, relays a tool call and disconnects", async () => {
    const { owner, projectId } = await harness.connectToReady("cf-lifecycle");

    const started = await connectCloudflareToCandidate(owner, projectId);

    expect(cloudflare.callsTo("register")).toHaveLength(1);
    expect(started.pending).toMatchObject({
      name: PRESET,
      label: "Cloudflare Observability",
      preset: PRESET,
      resource: cloudflare.resource,
      state: "awaiting_confirmation",
    });
    expect(started.candidate.account).toEqual({
      userName: null,
      workspaceName: null,
      identityVerified: false,
    });
    expect(started.candidate.sameIdentityAsActive).toBe("unknown");

    const ready = await confirm(owner, projectId, started);
    expect(ready).toMatchObject({
      state: "ready",
      account: { identityVerified: false },
    });

    clock.advance(HOUR_MS);
    const launched = await launchIn(owner, projectId, [PRESET], {
      [PRESET]: cloudflare.resource,
    });
    const entry = launched.entries[PRESET];
    if (!entry) {
      throw new Error("expected a cloudflare-observability entry");
    }
    const called = await relay(entry, {
      body: rpc(1, "tools/call", { name: "cf-tool-0-0", arguments: {} }),
    });

    expect(called.status).toBe(200);
    expect(await called.json()).toMatchObject({ id: 1 });
    expect(cloudflare.refreshCount).toBe(1);
    expect(cloudflare.mcp.effectCount("cf-tool-0-0")).toBe(1);
    expect(notion.mcp.calls).toHaveLength(0);

    const disconnected = await harness.disconnect(
      owner,
      projectId,
      started.connectionId,
    );

    expect(disconnected).toMatchObject({
      revocation: "accepted",
      providerRemovalUrl: null,
      connection: { state: "disconnected", account: null },
    });
    expect(cloudflare.callsTo("revoke")).toHaveLength(1);
    expect(notion.callsTo("revoke")).toHaveLength(0);
  });

  test("next to Notion, each card lists and disconnects only its own", async () => {
    const {
      owner,
      projectId,
      connectionId: notionId,
    } = await harness.connectToReady("cf-with-notion");
    const started = await connectCloudflareToCandidate(owner, projectId);
    await confirm(owner, projectId, started);

    expect(
      (await toolNames(owner, projectId, started.connectionId)).names,
    ).toEqual(["cf-tool-0-0", "cf-tool-0-1"]);
    expect((await toolNames(owner, projectId, notionId)).names).toEqual([
      "notion-tool-0-0",
      "notion-tool-0-1",
    ]);

    await harness.disconnect(owner, projectId, started.connectionId);

    expect(
      await harness.getConnection(owner, projectId, notionId),
    ).toMatchObject({ state: "ready" });
    expect(notion.callsTo("revoke")).toHaveLength(0);
    expect(
      await toolNames(owner, projectId, started.connectionId),
    ).toMatchObject({ status: 409, code: "MANAGED_CONNECTION_NOT_READY" });
    expect((await toolNames(owner, projectId, notionId)).status).toBe(200);
  });
});
