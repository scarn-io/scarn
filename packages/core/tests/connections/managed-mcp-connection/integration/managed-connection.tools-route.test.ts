import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { createUuidV7, parseUuidV7 } from "@/common/contracts/uuid-v7";
import { MANAGED_MCP_TOOL_CACHE_TTL_MS } from "@/connections/managed-mcp-connection/application/managed-mcp-tool-cache";
import type { ManagedConnectionToolsContract } from "@/connections/managed-mcp-connection/contracts/managed-connection-contracts";
import {
  FAKE_MCP_ERROR_MARKER,
  FAKE_MCP_TOOL_OUTPUT_SCHEMA,
} from "tests/connections/support/fake-mcp-server";
import {
  addWriteMember,
  createProjectSecretsTestUser,
  type ProjectSecretsTestUser,
} from "tests/secrets/secret/integration/project-secret-test-support";
import { unwrapAsync } from "tests/utils";
import { createManagedConnectionHarness } from "./managed-connection-test-support";

const HOUR_MS = 60 * 60 * 1000;

type ToolsBody = {
  tools: ManagedConnectionToolsContract["tools"];
  listedAt: string;
  cached: boolean;
  code?: string;
  meta?: Record<string, unknown>;
};

/**
 * `GET /projects/:projectId/mcp-connections/:connectionId/tools`: lists a
 * ready connection's MCP tools for a member holding `executions:write`,
 * serves repeats from a 5-minute per-generation memory cache, and never
 * returns a token or anything the provider sent.
 */
describe("managed connection tools route", () => {
  const harness = createManagedConnectionHarness();
  const { fake, clock, app, appContext } = harness;

  afterEach(() => {
    fake.reset();
    clock.reset();
  });

  afterAll(async () => {
    await fake.stop();
  });

  const getTools = async (
    user: Pick<ProjectSecretsTestUser, "authHeaders"> | null,
    projectId: string,
    connectionId: string,
  ) => {
    const response = await app.handle(
      new Request(
        `http://localhost/api/projects/${projectId}/mcp-connections/${connectionId}/tools`,
        { headers: user?.authHeaders ?? {} },
      ),
    );
    const text = await response.text();
    for (const token of fake.issuedTokens) {
      expect(text).not.toContain(token);
    }
    expect(text).not.toContain(FAKE_MCP_ERROR_MARKER);
    return {
      status: response.status,
      headers: response.headers,
      body: JSON.parse(text) as ToolsBody,
    };
  };

  const toolListings = () => fake.mcp.callsTo("tools/list").length;

  test("lists tools, then serves the cached listing within 5 minutes", async () => {
    const { owner, projectId, connectionId } =
      await harness.connectToReady("tools-cache");

    const first = await getTools(owner, projectId, connectionId);

    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(first.body.cached).toBe(false);
    expect(first.body.tools.map((tool) => tool.name)).toEqual([
      "notion-tool-0-0",
      "notion-tool-0-1",
    ]);
    expect(first.body.tools[1]).toMatchObject({
      title: "Fake Tool 1",
      outputSchema: FAKE_MCP_TOOL_OUTPUT_SCHEMA,
    });
    expect(first.body.tools[0]).not.toHaveProperty("outputSchema");
    expect(new Date(first.body.listedAt).toISOString()).toBe(
      first.body.listedAt,
    );
    expect(toolListings()).toBe(1);

    clock.advance(MANAGED_MCP_TOOL_CACHE_TTL_MS - 1_000);
    const second = await getTools(owner, projectId, connectionId);

    expect(second.status).toBe(200);
    expect(second.body).toEqual({ ...first.body, cached: true });
    expect(toolListings()).toBe(1);

    clock.advance(1_000);
    const third = await getTools(owner, projectId, connectionId);

    expect(third.body.cached).toBe(false);
    expect(toolListings()).toBe(2);
  });

  test("a reconnect confirm bumps the generation and skips the cache", async () => {
    const { owner, projectId, connectionId } =
      await harness.connectToReady("tools-reconnect");
    await getTools(owner, projectId, connectionId);
    expect(toolListings()).toBe(1);

    const { pending, candidate } = await harness.reconnectToCandidate(
      owner,
      projectId,
      connectionId,
    );
    const during = await getTools(owner, projectId, connectionId);
    expect(during.body.cached).toBe(true);
    const confirmed = await unwrapAsync(
      harness
        .connections(projectId)({ connectionId })
        .candidate.confirm.post(
          {
            candidateId: candidate.id,
            fingerprint: candidate.fingerprint,
            expectedVersion: pending.version,
          },
          { headers: { ...owner.authHeaders, origin: harness.origin } },
        ),
    );
    expect(confirmed.generation).toBeGreaterThan(pending.generation);

    const after = await getTools(owner, projectId, connectionId);

    expect(after.status).toBe(200);
    expect(after.body.cached).toBe(false);
    expect(toolListings()).toBe(2);
  });

  test("a member without executions:write gets 403; a non-member or anonymous caller 404", async () => {
    const { owner, projectId, connectionId } =
      await harness.connectToReady("tools-authz");
    const member = await createProjectSecretsTestUser("tools-member");
    await addWriteMember(harness.apiClient, projectId, owner, member);
    await unwrapAsync(
      harness.apiClient.api
        .projects({ projectId })
        .members({ userId: parseUuidV7(member.userId) })
        .role.put({ role: "read" }, { headers: owner.authHeaders }),
    );
    const stranger = await createProjectSecretsTestUser("tools-stranger");

    const forbidden = await getTools(member, projectId, connectionId);
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.code).toBe("PROJECT_FORBIDDEN");
    for (const user of [stranger, null]) {
      expect((await getTools(user, projectId, connectionId)).status).toBe(404);
    }
    expect(toolListings()).toBe(0);
  });

  test("a connection that needs reconnecting is 409 with its state and drops the cache", async () => {
    const { owner, projectId, connectionId } =
      await harness.connectToReady("tools-not-ready");
    await getTools(owner, projectId, connectionId);
    clock.advance(HOUR_MS);
    fake.faults.refresh = "invalid_grant";

    const failed = await getTools(owner, projectId, connectionId);

    expect(failed.status).toBe(409);
    expect(failed.body).toMatchObject({
      code: "MANAGED_CONNECTION_NOT_READY",
      meta: { state: "reconnect_required", reasonCode: "refresh_failed" },
    });
    const again = await getTools(owner, projectId, connectionId);
    expect(again.status).toBe(409);
    expect(again.body.meta).toEqual(failed.body.meta);
    expect(toolListings()).toBe(1);
  });

  test("a refresh already in flight is 503 with Retry-After", async () => {
    const { owner, projectId, connectionId } =
      await harness.connectToReady("tools-busy");
    const connection = await appContext.managedConnectionRepo.findById(
      parseUuidV7(projectId),
      parseUuidV7(connectionId),
    );
    const grantId = connection?.servingGrantId;
    if (!connection || !grantId) {
      throw new Error("expected a serving grant");
    }
    const grant = await appContext.managedOAuthGrantRepo.findById(
      connection.projectId,
      connection.id,
      grantId,
    );
    if (!grant) {
      throw new Error("expected the grant");
    }
    await appContext.managedOAuthGrantRepo.save(
      grant.claimRefresh(createUuidV7(), clock.now()),
    );

    const busy = await getTools(owner, projectId, connectionId);

    expect(busy.status).toBe(503);
    expect(busy.headers.get("retry-after")).toBe("1");
    expect(busy.body.code).toBe("MANAGED_CONNECTION_REFRESH_BUSY");
    expect(toolListings()).toBe(0);
  });

  test("a provider failure is 502 with nothing the provider sent", async () => {
    const { owner, projectId, connectionId } =
      await harness.connectToReady("tools-provider");
    fake.faults.mcp = "mcp_redirect";
    fake.mcp.redirectTo = `${fake.origin}/elsewhere`;

    const failed = await getTools(owner, projectId, connectionId);

    expect(failed.status).toBe(502);
    expect(failed.body.code).toBe("MANAGED_CONNECTION_PROVIDER_UNAVAILABLE");
    expect(failed.body.meta).toBeUndefined();
    delete fake.faults.mcp;
    const retried = await getTools(owner, projectId, connectionId);
    expect(retried.body.cached).toBe(false);
  });
});
