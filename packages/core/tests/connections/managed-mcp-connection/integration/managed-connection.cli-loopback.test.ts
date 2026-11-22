/**
 * End to end for `scarn connections connect` (plan Phase 4): the CLI's real
 * loopback flow (`runLoopbackSignIn` over the generated client and a real
 * loopback listener) against the API and the fake OAuth server. The stubbed
 * browser follows the fake's `/authorize` and delivers its redirect to the
 * listener, as a browser would.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { removeUndecryptableSigningKeys } from "@scarn/identity/testing/access-jwt-signing-keys";
import { createScarnClient } from "@scarn/sdk/client";
import type { UuidV7 } from "@/common/contracts/uuid-v7";
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

describe("scarn connections connect against the API", () => {
  const harness = createManagedConnectionHarness();
  const { fake, clock, app, apiClient } = harness;

  afterEach(() => {
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
    const client = createScarnClient("http://localhost", {
      fetch: (input, init) => {
        const request = new Request(input, init);
        request.headers.set("authorization", `Bearer ${token}`);
        return app.handle(request);
      },
    });
    return createConnectionsApi(client);
  };

  /** Follows `/authorize` and hands its redirect to the loopback listener. */
  const followingBrowser =
    (rewrite: (location: URL) => URL = (location) => location) =>
    async (authorizationUrl: string) => {
      const location = await harness.authorize(authorizationUrl);
      await fetch(rewrite(location));
    };

  const setUp = async (label: string) => {
    const owner = await createProjectSecretsTestUser(label);
    const projectId = await createProjectSecretsTestProject(apiClient, owner);
    await harness.seedFakeConnection(projectId);
    return { projectId, api: await cliApiFor(owner) };
  };

  const signIn = (
    projectId: UuidV7,
    api: Awaited<ReturnType<typeof cliApiFor>>,
    options: {
      prompt?: () => Promise<boolean>;
      openBrowser?: (url: string) => Promise<void>;
    } = {},
  ) =>
    runLoopbackSignIn({
      projectId,
      projectRef: "owner/project",
      target: { kind: "connect", preset: "notion", name: "notion" },
      yes: options.prompt === undefined,
      noBrowser: false,
      reporter: noopBaseReporter,
      ports: {
        api,
        bindListener: bindLoopbackCallback,
        openBrowser: options.openBrowser ?? followingBrowser(),
        isTty: true,
        ...(options.prompt === undefined ? {} : { prompt: options.prompt }),
      },
    });

  test("connects, sending the listener's dynamic redirect to the token endpoint", async () => {
    const { projectId, api } = await setUp("cli-lb-connect");

    const outcome = await signIn(projectId, api);

    expect(outcome.kind).toBe("confirmed");
    expect(outcome.connection).toMatchObject({
      projectId,
      name: "notion",
      state: "ready",
      candidate: null,
    });
    expect(fake.callsTo("token")[0]?.params["redirect_uri"]).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/callback$/u,
    );
  });

  test("declining at the prompt cancels the candidate", async () => {
    const { projectId, api } = await setUp("cli-lb-decline");

    const outcome = await signIn(projectId, api, {
      prompt: () => Promise.resolve(false),
    });

    expect(outcome.kind).toBe("declined");
    expect(outcome.connection.candidate).toBeNull();
    expect(outcome.connection.state).not.toBe("ready");
  });

  test("a denial at the provider is explained from meta.reason", async () => {
    const { projectId, api } = await setUp("cli-lb-denied");
    const denying = followingBrowser((location) => {
      const denied = new URL(location.origin + location.pathname);
      denied.searchParams.set("error", "access_denied");
      denied.searchParams.set(
        "state",
        location.searchParams.get("state") ?? "",
      );
      const iss = location.searchParams.get("iss");
      if (iss !== null) denied.searchParams.set("iss", iss);
      return denied;
    });

    let error: Error | undefined;
    try {
      await signIn(projectId, api, { openBrowser: denying });
    } catch (caught) {
      error = caught as Error;
    }
    expect(error).toMatchObject({
      code: "connection_completion_failed",
      message: "Access wasn't granted, so nothing was connected.",
    });
    expect(fake.callsTo("token")).toHaveLength(0);
  });
});
