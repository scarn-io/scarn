import type { ProjectRole } from "@/projects/project/domain/project-role";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { parseUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import { MANAGED_OAUTH_ATTEMPT_TTL_MS } from "@/connections/managed-mcp-connection/domain/managed-oauth-attempt-entity";
import { cimdClientIdentity } from "@/connections/managed-mcp-connection/infra/cimd-client-registry";
import { MANAGED_OAUTH_DISCOVERY_CACHE_MS } from "@/connections/managed-mcp-connection/infra/mcp-oauth-provider";
import { getDb } from "@/lib/db";
import { managedOAuthAttempts, managedOAuthGrants } from "@/lib/db/schema";
import {
  addWriteMember,
  createProjectSecretsTestProject,
  createProjectSecretsTestUser,
  type ProjectSecretsTestUser,
} from "tests/secrets/secret/integration/project-secret-test-support";
import { unwrapAsync } from "tests/utils";
import { createSecondSession } from "./managed-connection-sessions";
import { createManagedConnectionHarness } from "./managed-connection-test-support";

const grantsOf = async (connectionId: string) =>
  await getDb()
    .select({ id: managedOAuthGrants.id })
    .from(managedOAuthGrants)
    .where(eq(managedOAuthGrants.connectionId, connectionId));

const attemptStatusesOf = async (connectionId: string) =>
  (
    await getDb()
      .select({
        status: managedOAuthAttempts.status,
        failureCode: managedOAuthAttempts.failureCode,
      })
      .from(managedOAuthAttempts)
      .where(eq(managedOAuthAttempts.connectionId, connectionId))
  ).map((row) => ({ status: row.status, failureCode: row.failureCode }));

const withParams = (url: URL, edit: (params: URLSearchParams) => void) => {
  const edited = new URL(url);
  edit(edited.searchParams);
  return edited;
};

/**
 * Every way a callback can be refused (decisions 7 and 8). A refused
 * callback stores no candidate and never reaches the provider's `/token`.
 */
describe("managed connection callback", () => {
  const harness = createManagedConnectionHarness({ slowMs: 300 });
  const { fake, clock } = harness;

  afterEach(() => {
    fake.reset();
    clock.reset();
  });

  afterAll(async () => {
    await fake.stop();
  });

  const expectNoCandidate = async (
    user: ProjectSecretsTestUser,
    projectId: UuidV7,
    connectionId: string,
    shown: { state: string; reasonCode?: string } = { state: "connecting" },
  ) => {
    expect(fake.callsTo("token")).toHaveLength(0);
    expect(await grantsOf(connectionId)).toHaveLength(0);
    const connection = await harness.getConnection(
      user,
      projectId,
      connectionId,
    );
    expect(connection).toMatchObject({ ...shown, candidate: null });
  };

  const shownExpired = { state: "disconnected", reasonCode: "attempt_expired" };

  test("a replayed callback creates no second candidate and no token call", async () => {
    const { owner, projectId, connectionId, callbackUrl, candidate } =
      await harness.connectToCandidate("cb-replay");
    expect(fake.callsTo("token")).toHaveLength(1);

    const { location } = await harness.callback(callbackUrl, owner.authHeaders);

    expect(location.searchParams.get("error")).toBe("invalid_callback");
    expect(fake.callsTo("token")).toHaveLength(1);
    expect(await grantsOf(connectionId)).toEqual([{ id: candidate.id }]);
    const connection = await harness.getConnection(
      owner,
      projectId,
      connectionId,
    );
    expect(connection.candidate).toEqual(candidate);
  });

  test("a callback after the attempt's 10 minutes is refused as expired", async () => {
    const { owner, projectId, connectionId, callbackUrl } =
      await harness.connectToCallback("cb-expired");
    clock.advance(MANAGED_OAUTH_ATTEMPT_TTL_MS);

    const { location } = await harness.callback(callbackUrl, owner.authHeaders);

    expect(location.searchParams.get("error")).toBe("attempt_expired");
    expect(location.pathname).toMatch(/\/settings$/u);
    await expectNoCandidate(owner, projectId, connectionId, shownExpired);
    expect(await attemptStatusesOf(connectionId)).toEqual([
      { status: "expired", failureCode: null },
    ]);
  });

  test("a callback on a different browser session learns nothing and leaves the attempt usable", async () => {
    const { owner, projectId, connectionId, callbackUrl } =
      await harness.connectToCallback("cb-session");
    const otherBrowser = await createSecondSession(owner);

    const { location } = await harness.callback(
      callbackUrl,
      otherBrowser.authHeaders,
    );

    expect(location.pathname).toBe("/");
    expect([...location.searchParams.entries()]).toEqual([
      ["error", "invalid_callback"],
    ]);
    await expectNoCandidate(owner, projectId, connectionId);
    expect(await attemptStatusesOf(connectionId)).toEqual([
      { status: "pending", failureCode: null },
    ]);
  });

  test("a callback for another user's attempt is refused the same way", async () => {
    const { owner, projectId, connectionId, callbackUrl } =
      await harness.connectToCallback("cb-other-user");
    const stranger = await createProjectSecretsTestUser("cb-stranger");

    const { location } = await harness.callback(
      callbackUrl,
      stranger.authHeaders,
    );

    expect(location.pathname).toBe("/");
    expect(location.searchParams.get("error")).toBe("invalid_callback");
    await expectNoCandidate(owner, projectId, connectionId);
  });

  test("a duplicate code parameter is refused", async () => {
    const { owner, projectId, connectionId, callbackUrl } =
      await harness.connectToCallback("cb-dup-code");

    const { location } = await harness.callback(
      withParams(callbackUrl, (params) => {
        params.append("code", "second-code");
      }),
      owner.authHeaders,
    );

    expect(location.searchParams.get("error")).toBe("invalid_callback");
    await expectNoCandidate(owner, projectId, connectionId);
  });

  test("a callback carrying both code and error is refused", async () => {
    const { owner, projectId, connectionId, callbackUrl } =
      await harness.connectToCallback("cb-code-error");

    const { location } = await harness.callback(
      withParams(callbackUrl, (params) => {
        params.set("error", "access_denied");
      }),
      owner.authHeaders,
    );

    expect(location.searchParams.get("error")).toBe("invalid_callback");
    await expectNoCandidate(owner, projectId, connectionId);
    expect(await attemptStatusesOf(connectionId)).toEqual([
      { status: "failed", failureCode: "invalid_callback" },
    ]);
  });

  test("a callback without iss is refused", async () => {
    fake.faults.authorize = "missing_iss";
    const { owner, projectId, connectionId, callbackUrl } =
      await harness.connectToCallback("cb-missing-iss");
    expect(callbackUrl.searchParams.has("iss")).toBe(false);

    const { location } = await harness.callback(callbackUrl, owner.authHeaders);

    expect(location.searchParams.get("error")).toBe("invalid_callback");
    await expectNoCandidate(owner, projectId, connectionId);
  });

  test("a callback with the wrong iss is refused", async () => {
    fake.faults.authorize = "wrong_iss";
    const { owner, projectId, connectionId, callbackUrl } =
      await harness.connectToCallback("cb-wrong-iss");

    const { location } = await harness.callback(callbackUrl, owner.authHeaders);

    expect(location.searchParams.get("error")).toBe("invalid_callback");
    await expectNoCandidate(owner, projectId, connectionId);
  });

  test("an authorize request with a redirect_uri other than Scarn's is refused by the provider", async () => {
    const owner = await createProjectSecretsTestUser("cb-redirect");
    const projectId = await createProjectSecretsTestProject(
      harness.apiClient,
      owner,
    );
    const { connectionId, authorizationUrl } = await harness.startConnect(
      owner,
      projectId,
    );
    expect(new URL(authorizationUrl).searchParams.get("redirect_uri")).toBe(
      cimdClientIdentity(harness.appContext.apiBaseUrl).redirectUri,
    );
    const tampered = new URL(authorizationUrl);
    tampered.searchParams.set(
      "redirect_uri",
      "https://evil.example/api/oauth/mcp/callback",
    );

    const response = await fetch(tampered, { redirect: "manual" });

    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
    await expectNoCandidate(owner, projectId, connectionId);
  });

  test("two concurrent callbacks for one attempt exchange the code exactly once", async () => {
    const { owner, projectId, connectionId, callbackUrl } =
      await harness.connectToCallback("cb-concurrent");
    fake.faults.token = "slow";

    const results = await Promise.all([
      harness.callback(callbackUrl, owner.authHeaders),
      harness.callback(callbackUrl, owner.authHeaders),
    ]);

    expect(fake.callsTo("token")).toHaveLength(1);
    const errors = results
      .map(({ location }) => location.searchParams.get("error"))
      .sort();
    expect(errors).toEqual(["invalid_callback", null].sort());
    expect(await grantsOf(connectionId)).toHaveLength(1);
    const connection = await harness.getConnection(
      owner,
      projectId,
      connectionId,
    );
    expect(connection.state).toBe("awaiting_confirmation");
  });

  test("a callback for an actor whose secrets:write was removed is refused", async () => {
    const owner = await createProjectSecretsTestUser("cb-revoke-owner");
    const admin = await createProjectSecretsTestUser("cb-revoke-admin");
    const projectId = await createProjectSecretsTestProject(
      harness.apiClient,
      owner,
    );
    await addWriteMember(harness.apiClient, projectId, owner, admin);
    const setRole = async (role: ProjectRole) =>
      await unwrapAsync(
        harness.apiClient.api
          .projects({ projectId })
          .members({ userId: parseUuidV7(admin.userId) })
          .role.put({ role }, { headers: owner.authHeaders }),
      );
    await setRole("admin");
    const { connectionId, authorizationUrl } = await harness.startConnect(
      admin,
      projectId,
    );
    const callbackUrl = await harness.authorize(authorizationUrl);
    await setRole("write");

    const { location } = await harness.callback(callbackUrl, admin.authHeaders);

    expect(location.searchParams.get("error")).toBe("invalid_callback");
    await expectNoCandidate(owner, projectId, connectionId);
    expect(await attemptStatusesOf(connectionId)).toEqual([
      { status: "cancelled", failureCode: null },
    ]);
  });

  describe("error callbacks", () => {
    const asErrorCallback = (callbackUrl: URL) =>
      withParams(callbackUrl, (params) => {
        params.delete("code");
        params.set("error", "access_denied");
      });

    test("a well-formed denial ends the attempt as access_denied", async () => {
      const { owner, projectId, connectionId, callbackUrl } =
        await harness.connectToCallback("cb-denied");

      const { location } = await harness.callback(
        asErrorCallback(callbackUrl),
        owner.authHeaders,
      );

      expect(location.searchParams.get("error")).toBe("access_denied");
      await expectNoCandidate(owner, projectId, connectionId);
      expect(await attemptStatusesOf(connectionId)).toEqual([
        { status: "failed", failureCode: "access_denied" },
      ]);
    });

    test("a denial with the wrong iss is refused before it is accepted", async () => {
      const { owner, projectId, connectionId, callbackUrl } =
        await harness.connectToCallback("cb-denied-iss");

      const { location } = await harness.callback(
        withParams(asErrorCallback(callbackUrl), (params) => {
          params.set("iss", "https://evil.example");
        }),
        owner.authHeaders,
      );

      expect(location.searchParams.get("error")).toBe("invalid_callback");
      await expectNoCandidate(owner, projectId, connectionId);
      expect(await attemptStatusesOf(connectionId)).toEqual([
        { status: "failed", failureCode: "invalid_callback" },
      ]);
    });

    test("a denial on a different browser session leaves the attempt untouched", async () => {
      const { owner, projectId, connectionId, callbackUrl } =
        await harness.connectToCallback("cb-denied-session");
      const otherBrowser = await createSecondSession(owner);

      const { location } = await harness.callback(
        asErrorCallback(callbackUrl),
        otherBrowser.authHeaders,
      );

      expect(location.pathname).toBe("/");
      expect(location.searchParams.get("error")).toBe("invalid_callback");
      await expectNoCandidate(owner, projectId, connectionId);
      expect(await attemptStatusesOf(connectionId)).toEqual([
        { status: "pending", failureCode: null },
      ]);
    });

    test("a denial after expiry is reported as expired", async () => {
      const { owner, projectId, connectionId, callbackUrl } =
        await harness.connectToCallback("cb-denied-expired");
      clock.advance(MANAGED_OAUTH_ATTEMPT_TTL_MS);

      const { location } = await harness.callback(
        asErrorCallback(callbackUrl),
        owner.authHeaders,
      );

      expect(location.searchParams.get("error")).toBe("attempt_expired");
      await expectNoCandidate(owner, projectId, connectionId, shownExpired);
    });
  });
});

/**
 * The `iss` rule for a server without a preset (plan decision 7): `iss` is
 * required only once the server advertises support for it, and a present
 * but wrong `iss` is always refused.
 */
describe("managed connection callback without a preset", () => {
  const harness = createManagedConnectionHarness({ preset: null });
  const { fake, clock } = harness;

  afterEach(() => {
    fake.reset();
    clock.advance(MANAGED_OAUTH_DISCOVERY_CACHE_MS);
  });

  afterAll(async () => {
    await fake.stop();
  });

  test("a callback without iss is accepted when the server doesn't advertise it", async () => {
    fake.authorizationServerOverrides = {
      authorization_response_iss_parameter_supported: false,
    };
    fake.faults.authorize = "missing_iss";
    const { owner, callbackUrl } =
      await harness.connectToCallback("cb-np-missing-iss");
    expect(callbackUrl.searchParams.has("iss")).toBe(false);

    const { location } = await harness.callback(callbackUrl, owner.authHeaders);

    expect(location.searchParams.get("error")).toBeNull();
    expect(fake.callsTo("token")).toHaveLength(1);
  });

  test("a callback without iss is refused when the server advertises it", async () => {
    fake.faults.authorize = "missing_iss";
    const { owner, connectionId, callbackUrl } =
      await harness.connectToCallback("cb-np-advertised-iss");

    const { location } = await harness.callback(callbackUrl, owner.authHeaders);

    expect(location.searchParams.get("error")).toBe("invalid_callback");
    expect(fake.callsTo("token")).toHaveLength(0);
    expect(await grantsOf(connectionId)).toHaveLength(0);
  });

  test("a callback with the wrong iss is refused even when the server doesn't advertise it", async () => {
    fake.authorizationServerOverrides = {
      authorization_response_iss_parameter_supported: false,
    };
    fake.faults.authorize = "wrong_iss";
    const { owner, connectionId, callbackUrl } =
      await harness.connectToCallback("cb-np-wrong-iss");

    const { location } = await harness.callback(callbackUrl, owner.authHeaders);

    expect(location.searchParams.get("error")).toBe("invalid_callback");
    expect(fake.callsTo("token")).toHaveLength(0);
    expect(await grantsOf(connectionId)).toHaveLength(0);
  });
});
