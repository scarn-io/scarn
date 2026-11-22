/**
 * Scopes per connection (plan Phase 9, decision 11): a custom start's
 * `scopes` are stored on the connection and asked for by every sign-in,
 * instead of what the server's metadata advertises. A grant missing one is
 * still a candidate, and the candidate names what is missing.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { removeUndecryptableSigningKeys } from "@scarn/identity/testing/access-jwt-signing-keys";
import type { UuidV7 } from "@/common/contracts/uuid-v7";
import {
  createProjectSecretsTestProject,
  createProjectSecretsTestUser,
} from "tests/secrets/secret/integration/project-secret-test-support";
import { unwrapAsync } from "tests/utils";
import { createManagedConnectionHarness } from "./managed-connection-test-support";

const LOOPBACK_REDIRECT = "http://127.0.0.1:53682/callback";

describe("a custom connection's scopes", () => {
  const harness = createManagedConnectionHarness({ preset: null });
  const { fake, clock, app, apiClient, appContext, connections } = harness;

  afterEach(() => {
    fake.reset();
    fake.scopes = ["default"];
    clock.reset();
  });

  afterAll(async () => {
    await fake.stop();
  });

  const setUp = async (label: string) => {
    const owner = await createProjectSecretsTestUser(label);
    const projectId = await createProjectSecretsTestProject(apiClient, owner);
    await removeUndecryptableSigningKeys();
    const minted = await app.handle(
      new Request("http://localhost/api/auth/token", {
        headers: owner.authHeaders,
      }),
    );
    const { token } = (await minted.json()) as { token: string };
    return { owner, projectId, headers: { authorization: `Bearer ${token}` } };
  };

  /** Starts custom connection "files", signs in, and returns the pending connection. */
  const signIn = async (
    projectId: UuidV7,
    headers: Record<string, string>,
    scopes?: string[],
  ) => {
    const started = await unwrapAsync(
      connections(projectId).loopback.post(
        {
          custom: {
            name: "files",
            resource: fake.resource,
            confirmIssuerOrigin: fake.origin,
            ...(scopes === undefined ? {} : { scopes }),
          },
          redirectUri: LOOPBACK_REDIRECT,
        },
        { headers },
      ),
    );
    const location = await harness.authorize(started.authorizationUrl);
    return await unwrapAsync(
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
  };

  test("are stored, reach the authorization request, and show what wasn't granted", async () => {
    const { projectId, headers } = await setUp("custom-scopes");
    fake.scopes = ["files:read"];

    const pending = await signIn(projectId, headers, [
      "files:read",
      "files:write",
      "files:read",
    ]);

    expect(fake.callsTo("authorize")[0]?.params["scope"]).toBe(
      "files:read files:write",
    );
    expect(pending.scopes).toEqual(["files:read", "files:write"]);
    expect(pending.candidate).toMatchObject({
      grantedScopes: ["files:read"],
      missingScopes: ["files:write"],
    });
    const stored = await appContext.managedConnectionRepo.loadByName(
      projectId,
      "files",
    );
    expect(stored?.server.scopes).toEqual(["files:read", "files:write"]);
  });

  test("a grant missing a requested scope can still be confirmed, and reconnect asks for the same scopes", async () => {
    const { owner, projectId, headers } = await setUp("custom-scopes-confirm");
    fake.scopes = ["files:read"];
    const pending = await signIn(projectId, headers, [
      "files:read",
      "files:write",
    ]);
    const candidate = pending.candidate;
    if (!candidate) {
      throw new Error("expected a candidate");
    }

    const ready = await unwrapAsync(
      connections(projectId)({
        connectionId: pending.id,
      }).candidate.confirm.post(
        {
          candidateId: candidate.id,
          fingerprint: candidate.fingerprint,
          expectedVersion: pending.version,
        },
        { headers: { ...owner.authHeaders, origin: harness.origin } },
      ),
    );
    expect(ready).toMatchObject({
      state: "ready",
      grantedScopes: ["files:read"],
      scopes: ["files:read", "files:write"],
    });

    fake.reset();
    fake.scopes = ["files:read", "files:write"];
    const reconnected = await harness.reconnectToCandidate(
      owner,
      projectId,
      pending.id,
    );
    expect(fake.callsTo("authorize")[0]?.params["scope"]).toBe(
      "files:read files:write",
    );
    expect(reconnected.candidate).toMatchObject({
      grantedScopes: ["files:read", "files:write"],
      missingScopes: [],
    });
  });

  test("without scopes a sign-in asks for what the metadata advertises", async () => {
    const { projectId, headers } = await setUp("custom-scopes-none");

    const pending = await signIn(projectId, headers);

    expect(fake.callsTo("authorize")[0]?.params["scope"]).toBe("default");
    expect(pending.scopes).toBeNull();
    expect(pending.candidate).toMatchObject({
      grantedScopes: ["default"],
      missingScopes: [],
    });
    const stored = await appContext.managedConnectionRepo.loadByName(
      projectId,
      "files",
    );
    expect(stored?.server.scopes).toBeUndefined();
  });

  test("restarting an existing connection keeps the scopes it was created with", async () => {
    const { owner, projectId, headers } = await setUp("custom-scopes-restart");
    const pending = await signIn(projectId, headers, ["files:read"]);
    await unwrapAsync(
      connections(projectId)({
        connectionId: pending.id,
      }).candidate.cancel.post(
        { candidateId: pending.candidate?.id ?? "" },
        { headers: { ...owner.authHeaders, origin: harness.origin } },
      ),
    );
    fake.reset();

    await signIn(projectId, headers, ["files:write"]);

    expect(fake.callsTo("authorize")[0]?.params["scope"]).toBe("files:read");
  });

  test("a scope that isn't an OAuth scope token is refused", async () => {
    const { projectId, headers } = await setUp("custom-scopes-invalid");

    const response = await connections(projectId).loopback.post(
      {
        custom: {
          name: "files",
          resource: fake.resource,
          confirmIssuerOrigin: fake.origin,
          scopes: ["files read"],
        },
        redirectUri: LOOPBACK_REDIRECT,
      },
      { headers },
    );

    expect(response.status).toBe(422);
    expect(
      await appContext.managedConnectionRepo.loadByName(projectId, "files"),
    ).toBeNull();
  });
});
