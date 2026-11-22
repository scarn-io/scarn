import { describe, expect, test } from "bun:test";
import { runProjectIntegrationSync } from "@/integrations/github-ingest/application/run-project-integration-sync";
import {
  BitbucketProjectIntegration,
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

const basicAuth = (email: string, token: string) =>
  `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;

/**
 * A `bitbucket` integration syncs with the requesting user's Atlassian email
 * + API token, passed as `credential`; there is no stored credential.
 */
const createHarness = (status = 200) => {
  const { deps: credentialDeps, owner, saveSecret } = createResolverHarness();
  let stored: ProjectIntegrationEntity = BitbucketProjectIntegration.create({
    projectId: owner.userId,
    scope: {
      repos: [{ workspace: "acme", slug: "api", fullName: "acme/api" }],
    },
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
    requests.push({
      url: input.toString(),
      authorization: new Headers(init?.headers).get("authorization"),
    });
    return Promise.resolve(
      new Response(JSON.stringify(status === 200 ? { values: [] } : {}), {
        status,
      }),
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

const caughtError = async (run: () => Promise<unknown>): Promise<CoreError> => {
  try {
    await run();
  } catch (error: unknown) {
    if (error instanceof CoreError) return error;
    throw error;
  }
  throw new Error("Expected a CoreError");
};

describe("runProjectIntegrationSync — bitbucket", () => {
  test("reads with the pasted pair as basic auth", async () => {
    const { sync, requests, current } = createHarness();

    await sync({ email: "me@acme.test", apiToken: "bb-pasted" });

    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) {
      expect(request.url.startsWith("https://api.bitbucket.org/2.0/")).toBe(
        true,
      );
      expect(request.authorization).toBe(
        basicAuth("me@acme.test", "bb-pasted"),
      );
    }
    expect(current().status).toBe("active");
  });

  test("a saved token is decrypted, used and marked used", async () => {
    const { sync, requests, saveSecret, secretRepo, owner } = createHarness();
    const secret = await saveSecret(
      {
        kind: "bitbucket_api_token",
        name: "Work",
        metadata: { email: "saved@acme.test" },
        expiresAt: new Date("2027-10-20T12:00:00.000Z"),
      },
      "bb-saved",
    );

    await sync({ secretId: secret.id });

    expect(requests[0]?.authorization).toBe(
      basicAuth("saved@acme.test", "bb-saved"),
    );
    const reloaded = await secretRepo.findByIdForOwner(secret.id, owner);
    expect(reloaded?.lastUsedAt).not.toBeNull();
  });

  test("without a credential it is BITBUCKET_API_TOKEN_REQUIRED and records the error", async () => {
    const { sync, requests, current } = createHarness();

    expect((await caughtError(() => sync())).code).toBe(
      "BITBUCKET_API_TOKEN_REQUIRED",
    );
    expect(requests).toEqual([]);
    expect(current().status).toBe("error");
  });

  test("a GitHub-shaped credential is CREDENTIAL_PLATFORM_MISMATCH", async () => {
    const { sync, requests } = createHarness();

    expect((await caughtError(() => sync({ token: "ghp_x" }))).code).toBe(
      "CREDENTIAL_PLATFORM_MISMATCH",
    );
    expect(requests).toEqual([]);
  });

  test("a Bitbucket 401 is BITBUCKET_API_TOKEN_REJECTED without the token", async () => {
    const { sync } = createHarness(401);

    const error = await caughtError(() =>
      sync({ email: "me@acme.test", apiToken: "bb-rejected-value" }),
    );

    expect(error.code).toBe("BITBUCKET_API_TOKEN_REJECTED");
    expect(error.message).not.toContain("bb-rejected-value");
  });
});
