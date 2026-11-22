import { describe, expect } from "bun:test";
import { createUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import type { ProjectIntegrationKind } from "@/integrations/project-integration/domain/project-integration-entity";
import { InvariantViolationError } from "@/lib/errors";
import { ProjectEntity } from "@/projects/project/domain/project-entity";
import {
  AutoSyncCredentialUnusableError,
  resolveIntegrationSyncCredential,
  type ResolveIntegrationSyncCredentialDeps,
} from "@/secrets/secret/application/resolve-integration-sync-credential";
import type { SecretEntity } from "@/secrets/secret/domain/secret-entity";
import { userSecretOwner } from "@/secrets/secret/domain/secret-owner";
import { concurrentTest } from "tests/utils";
import {
  createResolverHarness,
  daysFrom,
  expectCoreErrorAsync,
} from "./credential-resolver-test-support";

const JIRA_EMAIL = "lender@example.com";
const JIRA_TOKEN = "jira-token-ABCD";
const GITHUB_TOKEN = "ghp_token_WXYZ";

const createSyncHarness = (now?: Date) => {
  const harness = createResolverHarness(now);
  const projectId = createUuidV7();
  const memberIds = new Set<UuidV7>([harness.owner.userId]);
  const deps: ResolveIntegrationSyncCredentialDeps = {
    secretRepo: harness.deps.secretRepo,
    secretCipher: harness.deps.secretCipher,
    timeProvider: harness.deps.timeProvider,
    projectRepo: {
      load: (id) =>
        Promise.resolve(
          id === projectId
            ? ProjectEntity.create({
                id: projectId,
                name: "Lent key project",
                slug: "lent-key-project",
                gitUrl: "https://github.com/acme/lent-key-project.git",
                createdByUserId: harness.owner.userId,
                orgId: createUuidV7(),
                memberships: [...memberIds].map((userId) => ({
                  projectId,
                  userId,
                  role: "read",
                })),
              })
            : null,
        ),
    },
  };

  const integration = (
    kind: ProjectIntegrationKind,
    syncSecretId: UuidV7 | null,
  ) => ({ id: createUuidV7(), kind, projectId, syncSecretId });

  const saveJiraKey = (expiresAt: Date = daysFrom(90)) =>
    harness.saveSecret(
      {
        kind: "jira_api_key",
        name: "Team Jira",
        metadata: { email: JIRA_EMAIL },
        expiresAt,
      },
      JIRA_TOKEN,
    );

  const saveGitHubToken = (expiresAt: Date | null = null) =>
    harness.saveSecret(
      {
        kind: "github_token",
        name: "Team GitHub",
        metadata: { login: "lender" },
        expiresAt,
      },
      GITHUB_TOKEN,
    );

  const removeOwnerFromProject = () => {
    memberIds.clear();
  };

  const deleteSecret = (secret: SecretEntity) =>
    harness.deps.secretRepo.delete(secret.id, secret.owner);

  return {
    deps,
    integration,
    saveJiraKey,
    saveGitHubToken,
    removeOwnerFromProject,
    deleteSecret,
    saveSecret: harness.saveSecret,
  };
};

const SENSITIVE = [JIRA_EMAIL, JIRA_TOKEN, GITHUB_TOKEN, "ABCD", "WXYZ"];

const expectUnusable = async (
  promise: Promise<unknown>,
  reason: AutoSyncCredentialUnusableError["reason"],
): Promise<AutoSyncCredentialUnusableError> => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AutoSyncCredentialUnusableError);
    const unusable = error as AutoSyncCredentialUnusableError;
    expect(unusable.reason).toBe(reason);
    const exposed = JSON.stringify({
      message: unusable.message,
      detail: unusable.detail,
      meta: unusable.meta,
    });
    for (const value of SENSITIVE) {
      expect(exposed).not.toContain(value);
    }
    return unusable;
  }
  throw new Error(`Expected AutoSyncCredentialUnusableError(${reason})`);
};

describe("resolveIntegrationSyncCredential", () => {
  describe("jira", () => {
    concurrentTest("decrypts the lent Jira key", async () => {
      const { deps, integration, saveJiraKey } = createSyncHarness();
      const key = await saveJiraKey();

      expect(
        await resolveIntegrationSyncCredential(
          integration("jira", key.id),
          deps,
        ),
      ).toEqual({
        kind: "jira",
        credential: {
          email: JIRA_EMAIL,
          apiToken: JIRA_TOKEN,
          secretId: key.id,
          secretName: "Team Jira",
        },
      });
    });

    concurrentTest("pauses with key_removed when no key is lent", async () => {
      const { deps, integration } = createSyncHarness();

      await expectUnusable(
        resolveIntegrationSyncCredential(integration("jira", null), deps),
        "key_removed",
      );
    });

    concurrentTest(
      "pauses with key_removed when the lent key was deleted",
      async () => {
        const { deps, integration, saveJiraKey, deleteSecret } =
          createSyncHarness();
        const key = await saveJiraKey();
        await deleteSecret(key);

        await expectUnusable(
          resolveIntegrationSyncCredential(integration("jira", key.id), deps),
          "key_removed",
        );
      },
    );

    concurrentTest(
      "pauses with key_rejected when a GitHub token is lent",
      async () => {
        const { deps, integration, saveGitHubToken } = createSyncHarness();
        const token = await saveGitHubToken();

        const error = await expectUnusable(
          resolveIntegrationSyncCredential(integration("jira", token.id), deps),
          "key_rejected",
        );
        expect(error.detail).toContain("Team GitHub");
      },
    );

    concurrentTest(
      "pauses with key_expired when the lent key has expired",
      async () => {
        const { deps, integration, saveJiraKey } = createSyncHarness(
          daysFrom(91),
        );
        const key = await saveJiraKey(daysFrom(90));

        await expectUnusable(
          resolveIntegrationSyncCredential(integration("jira", key.id), deps),
          "key_expired",
        );
      },
    );

    concurrentTest(
      "pauses with owner_left_project when the owner is no longer a member",
      async () => {
        const { deps, integration, saveJiraKey, removeOwnerFromProject } =
          createSyncHarness();
        const key = await saveJiraKey();
        removeOwnerFromProject();

        await expectUnusable(
          resolveIntegrationSyncCredential(integration("jira", key.id), deps),
          "owner_left_project",
        );
      },
    );
  });

  describe("github_token", () => {
    concurrentTest("decrypts the lent GitHub token", async () => {
      const { deps, integration, saveGitHubToken } = createSyncHarness();
      const token = await saveGitHubToken(daysFrom(30));

      expect(
        await resolveIntegrationSyncCredential(
          integration("github_token", token.id),
          deps,
        ),
      ).toEqual({
        kind: "github_token",
        credential: {
          token: GITHUB_TOKEN,
          secretId: token.id,
          secretName: "Team GitHub",
        },
      });
    });

    concurrentTest("pauses with key_removed when no key is lent", async () => {
      const { deps, integration } = createSyncHarness();

      await expectUnusable(
        resolveIntegrationSyncCredential(
          integration("github_token", null),
          deps,
        ),
        "key_removed",
      );
    });

    concurrentTest(
      "pauses with key_removed when the lent token was deleted",
      async () => {
        const { deps, integration, saveGitHubToken, deleteSecret } =
          createSyncHarness();
        const token = await saveGitHubToken();
        await deleteSecret(token);

        await expectUnusable(
          resolveIntegrationSyncCredential(
            integration("github_token", token.id),
            deps,
          ),
          "key_removed",
        );
      },
    );

    concurrentTest(
      "pauses with key_rejected when a Jira key is lent",
      async () => {
        const { deps, integration, saveJiraKey } = createSyncHarness();
        const key = await saveJiraKey();

        const error = await expectUnusable(
          resolveIntegrationSyncCredential(
            integration("github_token", key.id),
            deps,
          ),
          "key_rejected",
        );
        expect(error.detail).toContain("Team Jira");
      },
    );

    concurrentTest(
      "pauses with key_rejected when a Bitbucket token is lent",
      async () => {
        const { deps, integration, saveSecret } = createSyncHarness();
        const bitbucket = await saveSecret(
          {
            kind: "bitbucket_api_token",
            name: "Team Bitbucket",
            metadata: { email: JIRA_EMAIL },
            expiresAt: daysFrom(30),
          },
          "bb-token-ABCD",
        );

        await expectUnusable(
          resolveIntegrationSyncCredential(
            integration("github_token", bitbucket.id),
            deps,
          ),
          "key_rejected",
        );
      },
    );

    concurrentTest(
      "pauses with key_expired when the lent token has expired",
      async () => {
        const { deps, integration, saveGitHubToken } = createSyncHarness(
          daysFrom(31),
        );
        const token = await saveGitHubToken(daysFrom(30));

        await expectUnusable(
          resolveIntegrationSyncCredential(
            integration("github_token", token.id),
            deps,
          ),
          "key_expired",
        );
      },
    );

    concurrentTest(
      "pauses with owner_left_project when the owner is no longer a member",
      async () => {
        const { deps, integration, saveGitHubToken, removeOwnerFromProject } =
          createSyncHarness();
        const token = await saveGitHubToken();
        removeOwnerFromProject();

        await expectUnusable(
          resolveIntegrationSyncCredential(
            integration("github_token", token.id),
            deps,
          ),
          "owner_left_project",
        );
      },
    );
  });

  concurrentTest(
    "pauses with owner_left_project for a key owned by someone who never joined",
    async () => {
      const { deps, integration, saveSecret } = createSyncHarness();
      const otherOwner = userSecretOwner(createUuidV7());
      const key = await saveSecret(
        {
          kind: "github_token",
          name: "Stranger GitHub",
          metadata: { login: null },
          expiresAt: null,
        },
        GITHUB_TOKEN,
        otherOwner,
      );

      await expectUnusable(
        resolveIntegrationSyncCredential(
          integration("github_token", key.id),
          deps,
        ),
        "owner_left_project",
      );
    },
  );

  concurrentTest(
    "throws an invariant violation for a kind that can't auto-sync",
    async () => {
      const { deps, integration, saveGitHubToken } = createSyncHarness();
      const token = await saveGitHubToken();

      const error = await expectCoreErrorAsync(
        resolveIntegrationSyncCredential(
          integration("github_app", token.id),
          deps,
        ),
        "INVARIANT_VIOLATION",
      );
      expect(error).toBeInstanceOf(InvariantViolationError);
    },
  );
});
