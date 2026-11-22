import { describe, expect, test } from "bun:test";
import { runProjectIntegrationSync } from "@/integrations/github-ingest/application/run-project-integration-sync";
import {
  GitHubTokenProjectIntegration,
  type ProjectIntegrationEntity,
} from "@/integrations/project-integration/domain/project-integration-entity";
import type { ProjectIntegrationRepo } from "@/integrations/project-integration/application/project-integration-repo";
import type { WorkItemRepo } from "@/work-items/work-item/application/work-item-repo";
import type { WorkItemBlockRepo } from "@/work-items/work-item-block/application/work-item-block-repo";
import type { IntegrationCredentialChoice } from "@/secrets/secret/contracts/secret-contracts";
import { CoreError } from "@/lib/errors";
import { noopLogger } from "@scarn/observability/logging";
import { createResolverHarness } from "tests/secrets/secret/unit/credential-resolver-test-support";
import {
  makeGithubRelationshipPendingRefRepo,
  noopWorkItemEvents,
} from "./ingest-github-issue-relationships-test-support";

/**
 * A `github_token` integration syncs with the requesting user's own token,
 * passed as `credential`, and never mints an App token.
 */
const createHarness = (status = 200) => {
  const { deps: credentialDeps, owner, saveSecret } = createResolverHarness();
  let stored: ProjectIntegrationEntity = GitHubTokenProjectIntegration.create({
    projectId: owner.userId,
    scope: { repos: [{ id: 1, fullName: "acme/repo" }] },
  });
  const projectIntegrationRepo = {
    findById: () => Promise.resolve(stored),
    save: (entity: ProjectIntegrationEntity) => {
      stored = entity;
      return Promise.resolve(entity);
    },
  } as unknown as ProjectIntegrationRepo;

  const requests: { url: string; authorization: string | null }[] = [];
  const fetchImpl = ((input: string | URL, init?: RequestInit) => {
    const url = input.toString();
    requests.push({
      url,
      authorization: new Headers(init?.headers).get("authorization"),
    });
    const body = url.includes("/graphql") ? { data: {} } : [];
    return Promise.resolve(
      new Response(JSON.stringify(status === 200 ? body : {}), { status }),
    );
  }) as unknown as typeof fetch;

  const sync = (credential?: IntegrationCredentialChoice) =>
    runProjectIntegrationSync(
      {
        projectId: stored.projectId,
        integrationId: stored.id,
        githubApp: { appId: "", privateKey: "" },
        credential,
        cause: "manual",
      },
      {
        ...credentialDeps,
        userAuthz: {
          actorId: owner.userId,
          requireProjectMember: () =>
            Promise.reject(new Error("requireProjectMember is not used here")),
          requireProjectPermission: () =>
            Promise.resolve({
              membership: null,
              isPublicNonMemberGrant: false,
            }),
        },
        projectIntegrationRepo,
        workItemRepo: {} as WorkItemRepo,
        workItemBlockRepo: {} as WorkItemBlockRepo,
        workItemEvents: noopWorkItemEvents,
        githubRelationshipPendingRefRepo:
          makeGithubRelationshipPendingRefRepo().repo,
        upsertWorkItems: () => Promise.resolve([]),
        fetchImpl,
        logger: noopLogger,
      },
    );

  return {
    sync,
    requests,
    saveSecret,
    secretRepo: credentialDeps.secretRepo,
    owner,
    current: () => stored,
  };
};

const caughtCode = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
  } catch (error: unknown) {
    if (error instanceof CoreError) return error.code;
    throw error;
  }
  throw new Error("Expected a CoreError");
};

describe("runProjectIntegrationSync — github_token", () => {
  test("reads with the pasted credential as a Bearer token and never mints an App token", async () => {
    const { sync, requests, current } = createHarness();

    await sync({ token: "ghp_user_token" });

    expect(requests.length).toBeGreaterThan(0);
    expect(requests.some((r) => r.url.includes("/access_tokens"))).toBe(false);
    for (const request of requests) {
      expect(request.authorization).toBe("Bearer ghp_user_token");
    }
    expect(current().status).toBe("active");
  });

  test("a saved token is decrypted, used and marked used", async () => {
    const { sync, requests, saveSecret, secretRepo, owner } = createHarness();
    const secret = await saveSecret(
      {
        kind: "github_token",
        name: "Work",
        metadata: { login: "octo" },
        expiresAt: null,
      },
      "ghp_saved_value",
    );

    await sync({ secretId: secret.id });

    expect(requests[0]?.authorization).toBe("Bearer ghp_saved_value");
    const reloaded = await secretRepo.findByIdForOwner(secret.id, owner);
    expect(reloaded?.lastUsedAt).not.toBeNull();
  });

  test("without a credential it is GITHUB_TOKEN_REQUIRED and records the error", async () => {
    const { sync, requests, current } = createHarness();

    expect(await caughtCode(() => sync())).toBe("GITHUB_TOKEN_REQUIRED");
    expect(requests).toEqual([]);
    expect(current().status).toBe("error");
  });

  test("a Jira-shaped credential is CREDENTIAL_PLATFORM_MISMATCH", async () => {
    const { sync } = createHarness();

    expect(
      await caughtCode(() => sync({ email: "me@acme.test", apiKey: "k" })),
    ).toBe("CREDENTIAL_PLATFORM_MISMATCH");
  });

  test("a GitHub 401 is GITHUB_TOKEN_REJECTED without the token", async () => {
    const { sync } = createHarness(401);

    let message = "";
    const code = await caughtCode(async () => {
      try {
        await sync({ token: "ghp_rejected_value" });
      } catch (error: unknown) {
        message = error instanceof Error ? error.message : "";
        throw error;
      }
    });

    expect(code).toBe("GITHUB_TOKEN_REJECTED");
    expect(message).not.toContain("ghp_rejected_value");
  });
});
