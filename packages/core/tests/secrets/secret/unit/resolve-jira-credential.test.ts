import { describe, expect } from "bun:test";
import { resolveJiraCredential } from "@/secrets/secret/application/resolve-jira-credential";
import { concurrentTest } from "tests/utils";
import {
  createResolverHarness,
  daysFrom,
  expectCoreErrorAsync,
} from "./credential-resolver-test-support";

describe("resolveJiraCredential", () => {
  concurrentTest(
    "throws CREDENTIAL_PLATFORM_MISMATCH for a pasted GitHub or Bitbucket credential",
    async () => {
      const { deps } = createResolverHarness();

      await expectCoreErrorAsync(
        resolveJiraCredential({ token: "ghp_secret" }, deps),
        "CREDENTIAL_PLATFORM_MISMATCH",
      );
      await expectCoreErrorAsync(
        resolveJiraCredential(
          { email: "me@example.com", apiToken: "bb-secret" },
          deps,
        ),
        "CREDENTIAL_PLATFORM_MISMATCH",
      );
    },
  );

  concurrentTest(
    "throws SECRET_KIND_MISMATCH for a saved GitHub token",
    async () => {
      const { deps, saveSecret } = createResolverHarness();
      const github = await saveSecret(
        {
          kind: "github_token",
          name: "Personal GitHub",
          metadata: { login: null },
          expiresAt: null,
        },
        "ghp_secret",
      );

      await expectCoreErrorAsync(
        resolveJiraCredential({ secretId: github.id }, deps),
        "SECRET_KIND_MISMATCH",
      );
    },
  );

  concurrentTest("decrypts a saved Jira key", async () => {
    const { deps, saveSecret } = createResolverHarness();
    const jira = await saveSecret(
      {
        kind: "jira_api_key",
        name: "Work Jira",
        metadata: { email: "me@example.com" },
        expiresAt: daysFrom(90),
      },
      "jira-saved",
    );

    expect(await resolveJiraCredential({ secretId: jira.id }, deps)).toEqual({
      email: "me@example.com",
      apiToken: "jira-saved",
      secretId: jira.id,
      secretName: "Work Jira",
    });
  });
});
