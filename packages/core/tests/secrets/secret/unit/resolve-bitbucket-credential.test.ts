import { describe, expect } from "bun:test";
import { createUuidV7 } from "@/common/contracts/uuid-v7";
import {
  bitbucketCredentialRejectedError,
  resolveBitbucketCredential,
} from "@/secrets/secret/application/resolve-bitbucket-credential";
import { concurrentTest } from "tests/utils";
import {
  createResolverHarness,
  daysFrom,
  expectCoreErrorAsync,
} from "./credential-resolver-test-support";

const bitbucketToken = (expiresAt: Date = daysFrom(90)) => ({
  kind: "bitbucket_api_token" as const,
  name: "Work Bitbucket",
  metadata: { email: "me@example.com" },
  expiresAt,
});

describe("resolveBitbucketCredential", () => {
  concurrentTest(
    "throws BITBUCKET_API_TOKEN_REQUIRED without a choice",
    async () => {
      const { deps } = createResolverHarness();

      await expectCoreErrorAsync(
        resolveBitbucketCredential(undefined, deps),
        "BITBUCKET_API_TOKEN_REQUIRED",
      );
    },
  );

  concurrentTest("passes a pasted email + API token through", async () => {
    const { deps } = createResolverHarness();

    expect(
      await resolveBitbucketCredential(
        { email: "me@example.com", apiToken: "bb-pasted" },
        deps,
      ),
    ).toEqual({
      email: "me@example.com",
      apiToken: "bb-pasted",
      secretId: null,
      secretName: null,
    });
  });

  concurrentTest("decrypts a saved token with its email", async () => {
    const { deps, saveSecret } = createResolverHarness();
    const secret = await saveSecret(bitbucketToken(), "bb-saved");

    expect(
      await resolveBitbucketCredential({ secretId: secret.id }, deps),
    ).toEqual({
      email: "me@example.com",
      apiToken: "bb-saved",
      secretId: secret.id,
      secretName: "Work Bitbucket",
    });
  });

  concurrentTest(
    "throws CREDENTIAL_PLATFORM_MISMATCH for a pasted Jira or GitHub credential",
    async () => {
      const { deps } = createResolverHarness();

      const jira = await expectCoreErrorAsync(
        resolveBitbucketCredential(
          { email: "me@example.com", apiKey: "jira-secret" },
          deps,
        ),
        "CREDENTIAL_PLATFORM_MISMATCH",
      );
      const github = await expectCoreErrorAsync(
        resolveBitbucketCredential({ token: "ghp_secret" }, deps),
        "CREDENTIAL_PLATFORM_MISMATCH",
      );

      expect(jira.message).not.toContain("jira-secret");
      expect(github.message).not.toContain("ghp_secret");
    },
  );

  concurrentTest(
    "throws SECRET_KIND_MISMATCH for a saved Jira key",
    async () => {
      const { deps, saveSecret } = createResolverHarness();
      const jira = await saveSecret(
        {
          kind: "jira_api_key",
          name: "Work Jira",
          metadata: { email: "me@example.com" },
          expiresAt: daysFrom(90),
        },
        "jira-secret",
      );

      await expectCoreErrorAsync(
        resolveBitbucketCredential({ secretId: jira.id }, deps),
        "SECRET_KIND_MISMATCH",
      );
    },
  );

  concurrentTest("throws SECRET_EXPIRED for an expired token", async () => {
    const { deps, saveSecret } = createResolverHarness(daysFrom(10));
    const secret = await saveSecret(bitbucketToken(daysFrom(10)), "bb-old");

    await expectCoreErrorAsync(
      resolveBitbucketCredential({ secretId: secret.id }, deps),
      "SECRET_EXPIRED",
    );
  });

  concurrentTest("throws SECRET_NOT_FOUND for a missing secret", async () => {
    const { deps } = createResolverHarness();

    await expectCoreErrorAsync(
      resolveBitbucketCredential({ secretId: createUuidV7() }, deps),
      "SECRET_NOT_FOUND",
    );
  });
});

describe("bitbucketCredentialRejectedError", () => {
  concurrentTest("names the saved key, or the pasted pair generically", () => {
    const saved = bitbucketCredentialRejectedError({
      secretName: "Work Bitbucket",
    });
    const pasted = bitbucketCredentialRejectedError({ secretName: null });

    expect(saved.code).toBe("BITBUCKET_API_TOKEN_REJECTED");
    expect(saved.status).toBe(400);
    expect(saved.message).toContain('"Work Bitbucket"');
    expect(pasted.message).toBe(
      "Bitbucket rejected that email and API token.",
    );
  });
});
