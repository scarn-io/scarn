import { Elysia } from "elysia";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createAppContext } from "@scarn/core/lib/di";
import { createUuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { GitHubInstallationEntity } from "@scarn/core/integrations/github-installation/domain/github-installation-entity";
import type { GitHubInstallationRepo } from "@scarn/core/integrations/github-installation/application/github-installation-repo";
import { apiErrorHandler } from "../error-handler";
import type { GitHubInstallFlowDeps } from "./github-install-flow";
import { createGitHubIntegrationRoutes } from "./github-integration";
import { signInstallState, verifyInstallState } from "./install-state";

/**
 * The `intent: "create"` GitHub App install round-trip keeps the page it
 * started from: `/integrations/github/install` signs a same-origin `returnTo`
 * into the state, and the callback lands back on it — so the CLI hand-off's
 * prefill and `source=cli` survive the trip to GitHub.
 */

const notImplemented = (): never => {
  throw new Error("not implemented in this fake");
};

describe("GitHub App install round-trip (intent: create)", () => {
  const ENV_KEYS = [
    "BETTER_AUTH_SECRET",
    "GITHUB_APP_ID",
    "GITHUB_APP_SLUG",
    "GITHUB_APP_PRIVATE_KEY",
  ] as const;
  const originalEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};
  const userId = createUuidV7().toString();
  const returnTo =
    "/projects/new?gitUrl=git%40github.com%3Aacme%2Frepo.git&name=repo&source=cli";

  const makeInstallationRepo = (): GitHubInstallationRepo => ({
    upsert: (installation: GitHubInstallationEntity) =>
      Promise.resolve(installation),
    findByInstallationId: () => Promise.resolve(null),
    findByInstalledByUserId: notImplemented,
    deleteByInstallationId: notImplemented,
  });

  const deps: GitHubInstallFlowDeps = {
    getSessionUserId: () => Promise.resolve(userId),
    fetchInstallationMetadata: () =>
      Promise.resolve({
        accountLogin: "acme",
        accountType: "Organization",
        targetType: "selected",
        repositories: [{ id: 1, fullName: "acme/repo" }],
      }),
  };

  const buildInstallApp = (
    options: { appUrl?: string; flowDeps?: GitHubInstallFlowDeps } = {},
  ) =>
    new Elysia()
      .onError((context) => apiErrorHandler(context))
      .use(
        createGitHubIntegrationRoutes(
          createAppContext({
            githubInstallationRepo: makeInstallationRepo(),
            appUrl: options.appUrl ?? null,
          }),
          options.flowDeps ?? deps,
        ),
      );

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      originalEnv[key] = process.env[key];
    }
    process.env["BETTER_AUTH_SECRET"] = "test-secret-for-install-flow";
    process.env["GITHUB_APP_ID"] = "123";
    process.env["GITHUB_APP_SLUG"] = "scarn-test";
    process.env["GITHUB_APP_PRIVATE_KEY"] = "test-private-key";
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = originalEnv[key];
      if (value === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        process.env[key] = value;
      }
    }
  });

  const stateFromInstallRedirect = (res: Response): string => {
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.host).toBe("github.com");
    return location.searchParams.get("state") ?? "";
  };

  test("the install route signs a same-origin returnTo into the state", async () => {
    const res = await buildInstallApp().handle(
      new Request(
        `http://localhost/integrations/github/install?returnTo=${encodeURIComponent(returnTo)}`,
      ),
    );

    expect(res.status).toBe(302);
    const claims = verifyInstallState(stateFromInstallRedirect(res));
    expect(claims).toMatchObject({ intent: "create", returnTo });
  });

  test("the install route drops an off-origin returnTo", async () => {
    const res = await buildInstallApp().handle(
      new Request(
        `http://localhost/integrations/github/install?returnTo=${encodeURIComponent("//evil.example/projects/new")}`,
      ),
    );

    expect(res.status).toBe(302);
    const claims = verifyInstallState(stateFromInstallRedirect(res));
    expect(claims.intent).toBe("create");
    expect("returnTo" in claims).toBe(false);
  });

  test("the callback redirects to returnTo with installation=connected appended", async () => {
    const state = signInstallState({ intent: "create", returnTo });

    const res = await buildInstallApp().handle(
      new Request(
        `http://localhost/integrations/github/callback?installation_id=42&state=${encodeURIComponent(state)}`,
      ),
    );

    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.origin).toBe("http://localhost");
    expect(location.pathname).toBe("/projects/new");
    expect(location.searchParams.get("source")).toBe("cli");
    expect(location.searchParams.get("gitUrl")).toBe(
      "git@github.com:acme/repo.git",
    );
    expect(location.searchParams.get("name")).toBe("repo");
    expect(location.searchParams.get("installation")).toBe("connected");
  });

  test("the callback falls back to bare /projects/new without a returnTo", async () => {
    const state = signInstallState({ intent: "create" });

    const res = await buildInstallApp().handle(
      new Request(
        `http://localhost/integrations/github/callback?installation_id=42&state=${encodeURIComponent(state)}`,
      ),
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "http://localhost/projects/new?installation=connected",
    );
  });

  describe("with an app URL different from the API's", () => {
    const appUrl = "https://app.scarn.io";

    test("the callback lands returnTo on the app origin", async () => {
      const state = signInstallState({ intent: "create", returnTo });

      const res = await buildInstallApp({ appUrl }).handle(
        new Request(
          `https://api.scarn.io/integrations/github/callback?installation_id=42&state=${encodeURIComponent(state)}`,
        ),
      );

      expect(res.status).toBe(302);
      const location = new URL(res.headers.get("location") ?? "");
      expect(location.origin).toBe(appUrl);
      expect(location.pathname).toBe("/projects/new");
      expect(location.searchParams.get("source")).toBe("cli");
      expect(location.searchParams.get("installation")).toBe("connected");
    });

    test("the callback falls back to the app's /projects/new without a returnTo", async () => {
      const state = signInstallState({ intent: "create" });

      const res = await buildInstallApp({ appUrl }).handle(
        new Request(
          `https://api.scarn.io/integrations/github/callback?installation_id=42&state=${encodeURIComponent(state)}`,
        ),
      );

      expect(res.headers.get("location")).toBe(
        "https://app.scarn.io/projects/new?installation=connected",
      );
    });

    test("an invalid state redirects to the app root with the error", async () => {
      const res = await buildInstallApp({ appUrl }).handle(
        new Request(
          "https://api.scarn.io/integrations/github/callback?installation_id=42&state=bogus",
        ),
      );

      expect(res.status).toBe(302);
      const location = new URL(res.headers.get("location") ?? "");
      expect(location.origin).toBe(appUrl);
      expect(location.pathname).toBe("/");
      expect(location.searchParams.get("error")).toBeTruthy();
    });

    test("missing params redirect to the app root", async () => {
      const res = await buildInstallApp({ appUrl }).handle(
        new Request("https://api.scarn.io/integrations/github/callback"),
      );

      expect(res.headers.get("location")).toBe(
        "https://app.scarn.io/?error=missing_params",
      );
    });

    test("a signed-out browser is sent to the app's /login", async () => {
      const res = await buildInstallApp({
        appUrl,
        flowDeps: { ...deps, getSessionUserId: () => Promise.resolve(null) },
      }).handle(
        new Request("https://api.scarn.io/integrations/github/install"),
      );

      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("https://app.scarn.io/login");
    });
  });
});
