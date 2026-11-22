import { describe, expect } from "bun:test";
import { createUuidV7, parseUuidV7 } from "@/common/contracts/uuid-v7";
import {
  githubCredentialRejectedError,
  resolveGitHubCredential,
} from "@/secrets/secret/application/resolve-github-credential";
import { userSecretOwner } from "@/secrets/secret/domain/secret-owner";
import { concurrentTest } from "tests/utils";
import {
  createResolverHarness,
  daysFrom,
  expectCoreErrorAsync,
} from "./credential-resolver-test-support";

const githubToken = (expiresAt: Date | null = null) => ({
  kind: "github_token" as const,
  name: "Personal GitHub",
  metadata: { login: "octocat" },
  expiresAt,
});

describe("resolveGitHubCredential", () => {
  concurrentTest("throws GITHUB_TOKEN_REQUIRED without a choice", async () => {
    const { deps } = createResolverHarness();

    await expectCoreErrorAsync(
      resolveGitHubCredential(undefined, deps),
      "GITHUB_TOKEN_REQUIRED",
    );
  });

  concurrentTest("passes a pasted token through", async () => {
    const { deps } = createResolverHarness();

    expect(await resolveGitHubCredential({ token: "ghp_pasted" }, deps)).toEqual(
      { token: "ghp_pasted", secretId: null, secretName: null },
    );
  });

  concurrentTest(
    "decrypts a saved token, with or without an expiry",
    async () => {
      const { deps, saveSecret } = createResolverHarness();
      const neverExpires = await saveSecret(githubToken(), "ghp_never");
      const expires = await saveSecret(
        { ...githubToken(daysFrom(30)), name: "Expiring" },
        "ghp_expiring",
      );

      expect(
        await resolveGitHubCredential({ secretId: neverExpires.id }, deps),
      ).toEqual({
        token: "ghp_never",
        secretId: neverExpires.id,
        secretName: "Personal GitHub",
      });
      expect(
        (await resolveGitHubCredential({ secretId: expires.id }, deps)).token,
      ).toBe("ghp_expiring");
    },
  );

  concurrentTest(
    "throws CREDENTIAL_PLATFORM_MISMATCH for a pasted Jira or Bitbucket credential",
    async () => {
      const { deps } = createResolverHarness();

      const jira = await expectCoreErrorAsync(
        resolveGitHubCredential(
          { email: "me@example.com", apiKey: "jira-secret" },
          deps,
        ),
        "CREDENTIAL_PLATFORM_MISMATCH",
      );
      const bitbucket = await expectCoreErrorAsync(
        resolveGitHubCredential(
          { email: "me@example.com", apiToken: "bb-secret" },
          deps,
        ),
        "CREDENTIAL_PLATFORM_MISMATCH",
      );

      expect(jira.message).not.toContain("jira-secret");
      expect(bitbucket.message).not.toContain("bb-secret");
    },
  );

  concurrentTest(
    "throws SECRET_KIND_MISMATCH for a saved key of another kind",
    async () => {
      const { deps, saveSecret } = createResolverHarness();
      const bitbucket = await saveSecret(
        {
          kind: "bitbucket_api_token",
          name: "Work Bitbucket",
          metadata: { email: "me@example.com" },
          expiresAt: daysFrom(90),
        },
        "bb-secret",
      );

      const error = await expectCoreErrorAsync(
        resolveGitHubCredential({ secretId: bitbucket.id }, deps),
        "SECRET_KIND_MISMATCH",
      );
      expect(error.message).not.toContain("bb-secret");
    },
  );

  concurrentTest("throws SECRET_EXPIRED for an expired token", async () => {
    const { deps, saveSecret } = createResolverHarness(daysFrom(10));
    const secret = await saveSecret(githubToken(daysFrom(10)), "ghp_old");

    await expectCoreErrorAsync(
      resolveGitHubCredential({ secretId: secret.id }, deps),
      "SECRET_EXPIRED",
    );
  });

  concurrentTest(
    "throws SECRET_NOT_FOUND for a missing or another user's secret",
    async () => {
      const { deps, saveSecret } = createResolverHarness();
      const others = await saveSecret(
        githubToken(),
        "ghp_theirs",
        userSecretOwner(
          parseUuidV7("019a0000-0000-7000-8000-0000000000aa"),
        ),
      );

      await expectCoreErrorAsync(
        resolveGitHubCredential({ secretId: others.id }, deps),
        "SECRET_NOT_FOUND",
      );
      await expectCoreErrorAsync(
        resolveGitHubCredential({ secretId: createUuidV7() }, deps),
        "SECRET_NOT_FOUND",
      );
    },
  );
});

describe("githubCredentialRejectedError", () => {
  concurrentTest("names the saved key, or the pasted token generically", () => {
    const saved = githubCredentialRejectedError({ secretName: "Personal GitHub" });
    const pasted = githubCredentialRejectedError({ secretName: null });

    expect(saved.code).toBe("GITHUB_TOKEN_REJECTED");
    expect(saved.status).toBe(400);
    expect(saved.message).toContain('"Personal GitHub"');
    expect(pasted.code).toBe("GITHUB_TOKEN_REJECTED");
    expect(pasted.message).toBe("GitHub rejected that token.");
  });
});
