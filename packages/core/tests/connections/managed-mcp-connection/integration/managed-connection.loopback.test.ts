import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { DrizzleAuthSessionRepo } from "@scarn/identity";
import { parseUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import { completeManagedLoopbackAttempt } from "@/connections/managed-mcp-connection/application/complete-managed-loopback-attempt";
import { startManagedConnection } from "@/connections/managed-mcp-connection/application/start-managed-connection";
import { startManagedReconnect } from "@/connections/managed-mcp-connection/application/start-managed-reconnect";
import { MANAGED_OAUTH_ATTEMPT_TTL_MS } from "@/connections/managed-mcp-connection/domain/managed-oauth-attempt-entity";
import { managedOAuthCompletionSecretDigest } from "@/connections/managed-mcp-connection/domain/managed-oauth-digests";
import { cimdClientIdentity } from "@/connections/managed-mcp-connection/infra/cimd-client-registry";
import { MANAGED_CONNECTION_PRESETS } from "@/connections/managed-mcp-connection/infra/managed-connection-presets";
import { getDb } from "@/lib/db";
import { managedOAuthAttempts, managedOAuthGrants } from "@/lib/db/schema";
import {
  createProjectSecretsTestProject,
  createProjectSecretsTestUser,
  type ProjectSecretsTestUser,
} from "tests/secrets/secret/integration/project-secret-test-support";
import { createManagedConnectionHarness } from "./managed-connection-test-support";

const LOOPBACK_REDIRECT = "http://127.0.0.1:53682/callback";

const grantsOf = async (connectionId: string) =>
  await getDb()
    .select({ id: managedOAuthGrants.id })
    .from(managedOAuthGrants)
    .where(eq(managedOAuthGrants.connectionId, connectionId));

/** The error `started` rejects with, or null when it resolves. */
const refusalOf = async (started: Promise<object>) => {
  try {
    await started;
    return null;
  } catch (error) {
    return error;
  }
};

const attemptsOf = async (connectionId: string) =>
  await getDb()
    .select({
      status: managedOAuthAttempts.status,
      failureCode: managedOAuthAttempts.failureCode,
      completion: managedOAuthAttempts.completion,
      browserSessionDigest: managedOAuthAttempts.browserSessionDigest,
      completionSecretDigest: managedOAuthAttempts.completionSecretDigest,
      redirectUri: managedOAuthAttempts.redirectUri,
    })
    .from(managedOAuthAttempts)
    .where(eq(managedOAuthAttempts.connectionId, connectionId));

/**
 * Completing an attempt from the CLI's loopback listener (decisions 3 and 4):
 * the server exchanges the code the CLI caught and stores a candidate. Every
 * mismatch fails like a forged callback and makes no token request.
 */
describe("managed connection loopback completion", () => {
  const harness = createManagedConnectionHarness();
  const { fake, clock, appContext } = harness;

  afterEach(() => {
    fake.reset();
    clock.reset();
  });

  afterAll(async () => {
    await fake.stop();
  });

  const depsFor = (user: ProjectSecretsTestUser) => ({
    ...appContext,
    userAuthz: appContext.createUserAuthorizationService(
      parseUuidV7(user.userId),
    ),
  });

  const startLoopback = async (label: string) => {
    const owner = await createProjectSecretsTestUser(label);
    const projectId = await createProjectSecretsTestProject(
      harness.apiClient,
      owner,
    );
    await harness.seedFakeConnection(projectId);
    const started = await startManagedConnection(
      {
        projectId,
        definition: {
          name: "notion",
          label: MANAGED_CONNECTION_PRESETS.notion.label,
          ...harness.fakeTarget,
        },
        binding: { kind: "loopback", redirectUri: LOOPBACK_REDIRECT },
      },
      depsFor(owner),
    );
    return { owner, projectId, ...started };
  };

  /** Follows `/authorize` and returns what the provider redirected the CLI's listener to. */
  const redirectedTo = async (authorizationUrl: string) => {
    const location = await harness.authorize(authorizationUrl);
    expect(`${location.origin}${location.pathname}`).toBe(LOOPBACK_REDIRECT);
    return {
      state: location.searchParams.get("state") ?? "",
      code: location.searchParams.get("code") ?? "",
      iss: location.searchParams.get("iss") ?? "",
    };
  };

  const startToRedirect = async (label: string) => {
    const started = await startLoopback(label);
    return {
      ...started,
      redirect: await redirectedTo(started.authorizationUrl),
    };
  };

  const complete = (
    user: ProjectSecretsTestUser,
    input: {
      attemptId: UuidV7;
      completionSecret: string;
      state: string;
      code?: string;
      iss?: string;
      error?: string;
    },
  ) =>
    completeManagedLoopbackAttempt(
      { actorUserId: parseUuidV7(user.userId), ...input },
      appContext,
    );

  const unbound = {
    status: "failed",
    error: "invalid_callback",
    projectId: null,
    connectionId: null,
  } as const;

  const expectUntouched = async (connectionId: string) => {
    expect(fake.callsTo("token")).toHaveLength(0);
    expect(await grantsOf(connectionId)).toHaveLength(0);
    expect(
      (await attemptsOf(connectionId)).map(({ status }) => status),
    ).toEqual(["pending"]);
  };

  test("a loopback start stores only the secret's digest and asks for the loopback redirect", async () => {
    const { connectionId, completionSecret, authorizationUrl } =
      await startLoopback("lb-start");

    expect(completionSecret).toMatch(/^[\w-]{43}$/u);
    expect(new URL(authorizationUrl).searchParams.get("redirect_uri")).toBe(
      LOOPBACK_REDIRECT,
    );
    expect(await attemptsOf(connectionId)).toEqual([
      {
        status: "pending",
        failureCode: null,
        completion: "loopback",
        browserSessionDigest: null,
        completionSecretDigest:
          managedOAuthCompletionSecretDigest(completionSecret),
        redirectUri: LOOPBACK_REDIRECT,
      },
    ]);
  });

  test("the CLI's redirect is exchanged with the loopback redirect_uri and leaves a candidate to confirm", async () => {
    const {
      owner,
      projectId,
      connectionId,
      attemptId,
      completionSecret,
      redirect,
    } = await startToRedirect("lb-happy");

    const outcome = await complete(owner, {
      attemptId,
      completionSecret,
      ...redirect,
    });

    expect(outcome).toEqual({
      status: "candidate_stored",
      projectId,
      connectionId,
    });
    const tokenCalls = fake.callsTo("token");
    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0]?.params["redirect_uri"]).toBe(LOOPBACK_REDIRECT);
    const connection = await harness.getConnection(
      owner,
      projectId,
      connectionId,
    );
    expect(connection.state).toBe("awaiting_confirmation");
    expect(connection.candidate).not.toBeNull();
  });

  test("another user can't complete the attempt, even with its secret", async () => {
    const { connectionId, attemptId, completionSecret, redirect } =
      await startToRedirect("lb-other-user");
    const stranger = await createProjectSecretsTestUser("lb-stranger");

    expect(
      await complete(stranger, { attemptId, completionSecret, ...redirect }),
    ).toEqual(unbound);
    await expectUntouched(connectionId);
  });

  test("a wrong completion secret fails like a forged callback and leaves the attempt usable", async () => {
    const {
      owner,
      projectId,
      connectionId,
      attemptId,
      completionSecret,
      redirect,
    } = await startToRedirect("lb-wrong-secret");

    expect(
      await complete(owner, {
        attemptId,
        completionSecret: `${completionSecret.slice(0, -1)}x`,
        ...redirect,
      }),
    ).toEqual(unbound);
    await expectUntouched(connectionId);

    expect(
      await complete(owner, { attemptId, completionSecret, ...redirect }),
    ).toMatchObject({ status: "candidate_stored", projectId });
  });

  test("another attempt's ID fails like a forged callback", async () => {
    const first = await startToRedirect("lb-attempt-id");
    const other = await startLoopback("lb-attempt-id-other");

    expect(
      await complete(first.owner, {
        attemptId: other.attemptId,
        completionSecret: first.completionSecret,
        ...first.redirect,
      }),
    ).toEqual(unbound);
    await expectUntouched(first.connectionId);
  });

  test("a reused state creates no second candidate and no second token call", async () => {
    const {
      owner,
      projectId,
      connectionId,
      attemptId,
      completionSecret,
      redirect,
    } = await startToRedirect("lb-replay");
    await complete(owner, { attemptId, completionSecret, ...redirect });

    expect(
      await complete(owner, { attemptId, completionSecret, ...redirect }),
    ).toEqual({
      status: "failed",
      error: "invalid_callback",
      projectId,
      connectionId,
    });
    expect(fake.callsTo("token")).toHaveLength(1);
    expect(await grantsOf(connectionId)).toHaveLength(1);
  });

  test("a redirect after the attempt's 10 minutes is refused as expired", async () => {
    const { owner, connectionId, attemptId, completionSecret, redirect } =
      await startToRedirect("lb-expired");
    clock.advance(MANAGED_OAUTH_ATTEMPT_TTL_MS);

    expect(
      await complete(owner, { attemptId, completionSecret, ...redirect }),
    ).toMatchObject({ status: "failed", error: "attempt_expired" });
    expect(fake.callsTo("token")).toHaveLength(0);
    expect(
      (await attemptsOf(connectionId)).map(({ status }) => status),
    ).toEqual(["expired"]);
  });

  test("a denial ends the attempt as access_denied", async () => {
    const {
      owner,
      projectId,
      connectionId,
      attemptId,
      completionSecret,
      redirect,
    } = await startToRedirect("lb-denied");

    expect(
      await complete(owner, {
        attemptId,
        completionSecret,
        state: redirect.state,
        iss: redirect.iss,
        error: "access_denied",
      }),
    ).toEqual({
      status: "failed",
      error: "access_denied",
      projectId,
      connectionId,
    });
    expect(fake.callsTo("token")).toHaveLength(0);
    expect(await attemptsOf(connectionId)).toMatchObject([
      { status: "failed", failureCode: "access_denied" },
    ]);
  });

  test("the browser callback refuses a loopback attempt", async () => {
    const { owner, connectionId, redirect } =
      await startToRedirect("lb-via-browser");
    const callbackUrl = new URL(
      cimdClientIdentity(appContext.apiBaseUrl).redirectUri,
    );
    for (const [key, value] of Object.entries(redirect)) {
      callbackUrl.searchParams.set(key, value);
    }

    const { location } = await harness.callback(callbackUrl, owner.authHeaders);

    expect(location.pathname).toBe("/");
    expect([...location.searchParams.entries()]).toEqual([
      ["error", "invalid_callback"],
    ]);
    await expectUntouched(connectionId);
  });

  test("a browser attempt can't be completed from the loopback route", async () => {
    const { owner, connectionId, callbackUrl } =
      await harness.connectToCallback("lb-browser-attempt");
    const params = Object.fromEntries(callbackUrl.searchParams) as Record<
      string,
      string
    >;
    const [attempt] = await getDb()
      .select({ id: managedOAuthAttempts.id })
      .from(managedOAuthAttempts)
      .where(eq(managedOAuthAttempts.connectionId, connectionId));
    const session = await new DrizzleAuthSessionRepo().loadByToken(
      owner.sessionToken,
    );

    expect(
      await complete(owner, {
        attemptId: parseUuidV7(attempt?.id ?? ""),
        completionSecret: session?.id ?? "",
        state: params["state"] ?? "",
        code: params["code"] ?? "",
        iss: params["iss"] ?? "",
      }),
    ).toEqual(unbound);
    await expectUntouched(connectionId);
  });

  test("a reconnect can be completed from the loopback route too", async () => {
    const { owner, projectId, connectionId } =
      await harness.connectToReady("lb-reconnect");
    fake.reset();

    const started = await startManagedReconnect(
      {
        projectId,
        connectionId: parseUuidV7(connectionId),
        binding: { kind: "loopback", redirectUri: LOOPBACK_REDIRECT },
      },
      depsFor(owner),
    );
    const redirect = await redirectedTo(started.authorizationUrl);

    expect(
      await complete(owner, {
        attemptId: started.attemptId,
        completionSecret: started.completionSecret,
        ...redirect,
      }),
    ).toEqual({ status: "candidate_stored", projectId, connectionId });
    expect(fake.callsTo("token")[0]?.params["redirect_uri"]).toBe(
      LOOPBACK_REDIRECT,
    );
  });

  test.each([
    "https://evil.example/callback",
    "http://localhost:53682/callback",
    "http://127.0.0.1:53682/oauth/callback",
    "http://127.0.0.1/callback",
  ])(
    "a redirect the portless loopback redirect doesn't cover (%s) is refused before anything starts",
    async (redirectUri) => {
      const owner = await createProjectSecretsTestUser("lb-bad-redirect");
      const projectId = await createProjectSecretsTestProject(
        harness.apiClient,
        owner,
      );

      const refusal = await refusalOf(
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
      expect(refusal).toMatchObject({
        code: "MANAGED_CONNECTION_REDIRECT_INVALID",
        status: 422,
      });
      expect(fake.calls).toHaveLength(0);
    },
  );
});
