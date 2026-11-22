import { afterAll, describe, expect } from "bun:test";
import {
  createProjectSecretsTestProject,
  createProjectSecretsTestUser,
} from "tests/secrets/secret/integration/project-secret-test-support";
import { serialTest, unwrapAsync } from "tests/utils";
import {
  createManagedConnectionHarness,
  MANAGED_CONNECTION_APP_URL,
} from "./managed-connection-test-support";

/**
 * Connecting a project to Notion end to end against the loopback fake:
 * start, follow `/authorize`, land on the callback in the same session,
 * confirm the candidate, and see the account on the list.
 */
describe("managed connection lifecycle", () => {
  const { fake, app, apiClient, origin, seedFakeConnection } =
    createManagedConnectionHarness();

  const state = {} as {
    owner: Awaited<ReturnType<typeof createProjectSecretsTestUser>>;
    projectId: Awaited<ReturnType<typeof createProjectSecretsTestProject>>;
    connectionId: string;
    authorizationUrl: string;
    callbackUrl: string;
  };

  afterAll(async () => {
    await fake.stop();
  });

  serialTest("an admin starts connecting the project", async () => {
    state.owner = await createProjectSecretsTestUser("lifecycle-owner");
    state.projectId = await createProjectSecretsTestProject(
      apiClient,
      state.owner,
    );
    await seedFakeConnection(state.projectId);

    const { connectionId, authorizationUrl } = await unwrapAsync(
      apiClient.api
        .projects({ projectId: state.projectId })
        ["mcp-connections"].post(
          { preset: "notion" },
          {
            headers: { ...state.owner.authHeaders, origin },
          },
        ),
    );

    state.connectionId = connectionId;
    state.authorizationUrl = authorizationUrl;
    expect(new URL(authorizationUrl).origin).toBe(fake.origin);
    const connection = await unwrapAsync(
      apiClient.api
        .projects({ projectId: state.projectId })
        ["mcp-connections"]({ connectionId })
        .get({ headers: state.owner.authHeaders }),
    );
    expect(connection).toMatchObject({ state: "connecting", candidate: null });
  });

  serialTest(
    "the provider approves and redirects to the callback",
    async () => {
      const response = await fetch(state.authorizationUrl, {
        redirect: "manual",
      });

      expect(response.status).toBe(302);
      state.callbackUrl = response.headers.get("location") ?? "";
      expect(
        state.callbackUrl.startsWith(
          `${MANAGED_CONNECTION_APP_URL}/api/oauth/mcp/callback?`,
        ),
      ).toBe(true);
    },
  );

  serialTest(
    "the callback stores a candidate and returns to settings",
    async () => {
      const response = await app.handle(
        new Request(state.callbackUrl, { headers: state.owner.authHeaders }),
      );

      expect(response.status).toBe(302);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      const location = new URL(response.headers.get("location") ?? "");
      expect(location.pathname).toMatch(/\/settings$/u);
      expect([...location.searchParams.entries()]).toEqual([
        ["connection", state.connectionId],
      ]);
      expect(fake.callsTo("token")).toHaveLength(1);
    },
  );

  serialTest("the admin confirms the candidate it was shown", async () => {
    const pending = await unwrapAsync(
      apiClient.api
        .projects({ projectId: state.projectId })
        ["mcp-connections"]({ connectionId: state.connectionId })
        .get({ headers: state.owner.authHeaders }),
    );
    expect(pending).toMatchObject({
      state: "awaiting_confirmation",
      account: null,
      candidate: {
        account: {
          userName: fake.identity.userName,
          workspaceName: fake.identity.workspaceName,
          identityVerified: true,
        },
        grantedScopes: ["default"],
        sameIdentityAsActive: "unknown",
      },
    });
    const candidate = pending.candidate;
    if (!candidate) {
      throw new Error("expected a candidate");
    }

    const confirmed = await unwrapAsync(
      apiClient.api
        .projects({ projectId: state.projectId })
        ["mcp-connections"]({ connectionId: state.connectionId })
        .candidate.confirm.post(
          {
            candidateId: candidate.id,
            fingerprint: candidate.fingerprint,
            expectedVersion: pending.version,
          },
          { headers: { ...state.owner.authHeaders, origin } },
        ),
    );

    expect(confirmed).toMatchObject({
      state: "ready",
      candidate: null,
      connectedBy: { userId: state.owner.userId },
    });
  });

  serialTest("the list shows the connected account", async () => {
    const connections = await unwrapAsync(
      apiClient.api
        .projects({ projectId: state.projectId })
        ["mcp-connections"].get({ headers: state.owner.authHeaders }),
    );

    expect(connections).toHaveLength(1);
    expect(connections[0]).toMatchObject({
      id: state.connectionId,
      name: "notion",
      label: "Notion",
      preset: "notion",
      resource: fake.resource,
      state: "ready",
      generation: 0,
      account: {
        userName: fake.identity.userName,
        workspaceName: fake.identity.workspaceName,
        identityVerified: true,
      },
      grantedScopes: ["default"],
    });
    expect(connections[0]?.reconnectBy).not.toBeNull();
  });
});
