import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createAppContext } from "@/lib/di";
import { createApp } from "@scarn/api/app";
import { createTestUserAndSession } from "@scarn/identity/testing";
import { createScarnTreaty } from "tests/treaty";
import { unwrapAsync } from "tests/utils";
import {
  createGitHubEnvGuard,
  installGitHubFetchStub,
  seedInstallation,
} from "./project-setup-test-support";

/**
 * `POST /projects/repo-check`. Toggles the GitHub App env, so tests run
 * serially.
 */
describe("POST /projects/repo-check", () => {
  const appContext = createAppContext();
  const apiClient = createScarnTreaty(createApp(appContext));
  const env = createGitHubEnvGuard();

  beforeEach(env.clear);
  afterEach(env.restore);

  const newUser = async (label: string) =>
    await createTestUserAndSession({
      email: `repo-check-${label}-${crypto.randomUUID()}@example.com`,
    });

  const check = (gitUrl: string, headers: Record<string, string>) =>
    apiClient.api.projects["repo-check"].post({ gitUrl }, { headers });

  test("describes a GitHub repo and leaves githubApp out when the App isn't configured", async () => {
    const owner = await newUser("github");

    const result = await unwrapAsync(
      check("git@github.com:Acme/Widgets.git", owner.authHeaders),
    );

    expect(result).toEqual({
      host: "github",
      webUrl: "https://github.com/Acme/Widgets",
      defaultName: "Widgets",
      alreadyExists: false,
      existingProject: null,
    });
  });

  test("finds the caller's installation that covers the repo", async () => {
    env.configureApp();
    const owner = await newUser("covered");
    const installationId = `repo-check-${crypto.randomUUID()}`;
    await seedInstallation(
      appContext.githubInstallationRepo,
      owner.userId,
      installationId,
      { id: 5, fullName: "acme/widgets" },
    );

    const result = await unwrapAsync(
      check("https://github.com/Acme/Widgets", owner.authHeaders),
    );

    expect(result.githubApp).toEqual({ installationId, accountLogin: "acme" });
  });

  test("finds the installation by repo id when the URL uses the repo's old name", async () => {
    env.configureApp();
    const requests = installGitHubFetchStub({
      repo: { id: 41, fullName: "acme-co/renamed" },
    });
    const owner = await newUser("renamed");
    const installationId = `repo-check-${crypto.randomUUID()}`;
    await seedInstallation(
      appContext.githubInstallationRepo,
      owner.userId,
      installationId,
      { id: 41, fullName: "acme-co/renamed" },
    );

    const result = await unwrapAsync(
      check("https://github.com/acme/old-name.git", owner.authHeaders),
    );

    expect(result.githubApp).toEqual({
      installationId,
      accountLogin: "acme-co",
    });
    expect(requests.at(-1)).toEqual({
      url: "https://api.github.com/repos/acme/old-name",
      authorization: "Bearer test-installation-token",
    });
  });

  test("returns githubApp null when GitHub resolves the URL to a repo the installation doesn't cover", async () => {
    env.configureApp();
    installGitHubFetchStub({ repo: { id: 99, fullName: "someone/public" } });
    const owner = await newUser("uncovered");
    await seedInstallation(
      appContext.githubInstallationRepo,
      owner.userId,
      `repo-check-${crypto.randomUUID()}`,
      { id: 42, fullName: "acme-co/private" },
    );

    const result = await unwrapAsync(
      check("https://github.com/someone/public", owner.authHeaders),
    );

    expect(result.githubApp).toBeNull();
  });

  test("returns githubApp null when only someone else's installation covers the repo", async () => {
    env.configureApp();
    const owner = await newUser("installer");
    const other = await newUser("other");
    await seedInstallation(
      appContext.githubInstallationRepo,
      owner.userId,
      `repo-check-${crypto.randomUUID()}`,
      { id: 6, fullName: "acme/gadgets" },
    );

    const result = await unwrapAsync(
      check("https://github.com/acme/gadgets.git", other.authHeaders),
    );

    expect(result.githubApp).toBeNull();
  });

  test("flags a repo one of the caller's projects already uses, in any URL spelling", async () => {
    const owner = await newUser("exists");
    const created = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: "Existing",
          description: null,
          gitUrl: "https://github.com/acme/existing.git",
        },
        { headers: owner.authHeaders },
      ),
    );

    const mine = await unwrapAsync(
      check("git@github.com:ACME/existing", owner.authHeaders),
    );
    const someoneElse = await unwrapAsync(
      check("git@github.com:ACME/existing", (await newUser("x")).authHeaders),
    );

    expect(mine.alreadyExists).toBe(true);
    const [listed] = await unwrapAsync(
      apiClient.api.projects.get({ headers: owner.authHeaders }),
    );
    expect(mine.existingProject).toEqual({
      name: "Existing",
      slug: created.slug,
      ownerUsername: listed?.ownerUsername ?? null,
    });
    expect(mine.existingProject?.ownerUsername).not.toBeNull();
    expect(someoneElse.alreadyExists).toBe(false);
    expect(someoneElse.existingProject).toBeNull();
  });

  test("describes Bitbucket and other hosts", async () => {
    const owner = await newUser("hosts");

    const bitbucket = await unwrapAsync(
      check("https://bitbucket.org/team/api-service.git", owner.authHeaders),
    );
    const other = await unwrapAsync(
      check(
        "ssh://git@git.example.com/infra/deploy-tools.git",
        owner.authHeaders,
      ),
    );

    expect(bitbucket).toEqual({
      host: "bitbucket",
      webUrl: "https://bitbucket.org/team/api-service",
      defaultName: "api-service",
      alreadyExists: false,
      existingProject: null,
    });
    expect(other).toEqual({
      host: "other",
      webUrl: null,
      defaultName: "deploy-tools",
      alreadyExists: false,
      existingProject: null,
    });
  });

  test("rejects an invalid URL and an anonymous caller", async () => {
    const owner = await newUser("invalid");

    const invalid = await check("not a url", owner.authHeaders);
    const anonymous = await apiClient.api.projects["repo-check"].post({
      gitUrl: "https://github.com/acme/api.git",
    });

    expect(invalid.error?.status).toBe(422);
    expect(anonymous.error?.status).toBe(401);
  });
});
