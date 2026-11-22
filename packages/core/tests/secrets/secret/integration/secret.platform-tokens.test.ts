import { beforeAll, describe, expect } from "bun:test";
import { parseUuidV7 } from "@/common/contracts/uuid-v7";
import { concurrentTest, unwrapAsync } from "tests/utils";
import {
  bitbucketApiTokenInput,
  createSecretsTestClient,
  createSecretsTestUser,
  daysFromNow,
  githubTokenInput,
  jiraApiKeyInput,
} from "./secret-test-support";

describe("/me/secrets with GitHub and Bitbucket tokens", () => {
  const apiClient = createSecretsTestClient();
  let headers: { authorization: string };

  beforeAll(async () => {
    headers = (await createSecretsTestUser()).authHeaders;
  });

  concurrentTest(
    "creates a GitHub token without an expiry and never returns its value",
    async () => {
      const { data, error, status } = await apiClient.api.me.secrets.post(
        githubTokenInput({
          name: "  Personal GitHub ",
          value: "ghp_SECRET-marker-wxyz",
          login: "octocat",
        }),
        { headers },
      );

      expect(error).toBeNull();
      expect(status).toBe(201);
      expect(JSON.stringify(data)).not.toContain("ghp_SECRET");
      if (!data) throw new Error("expected a created secret");
      expect({
        ...data,
        id: "<id>",
        createdAt: "<createdAt>",
        updatedAt: "<updatedAt>",
      }).toMatchInlineSnapshot(
        `
        {
          "createdAt": "<createdAt>",
          "expiresAt": null,
          "id": "<id>",
          "kind": "github_token",
          "lastFour": "wxyz",
          "lastUsedAt": null,
          "metadata": {
            "login": "octocat",
          },
          "name": "Personal GitHub",
          "status": "active",
          "updatedAt": "<updatedAt>",
          "usedBy": [],
        }
      `,
      );
    },
  );

  concurrentTest("creates a GitHub token with an expiry", async () => {
    const created = await unwrapAsync(
      apiClient.api.me.secrets.post(
        githubTokenInput({ expiresAt: daysFromNow(10) }),
        { headers },
      ),
    );

    expect(created.kind).toBe("github_token");
    expect(created.expiresAt).toBe(daysFromNow(10));
    expect(created.status).toBe("expiring_soon");
    expect(created.metadata).toEqual({ login: null });
  });

  concurrentTest(
    "creates a Bitbucket API token with its email and expiry",
    async () => {
      const created = await unwrapAsync(
        apiClient.api.me.secrets.post(
          bitbucketApiTokenInput({
            email: " Me@Example.COM ",
            value: "bb-SECRET-marker-wxyz",
          }),
          { headers },
        ),
      );

      expect(JSON.stringify(created)).not.toContain("bb-SECRET");
      expect(created).toMatchObject({
        kind: "bitbucket_api_token",
        metadata: { email: "me@example.com" },
        expiresAt: daysFromNow(90),
        lastFour: "wxyz",
      });
    },
  );

  concurrentTest(
    "rejects a Bitbucket API token without an expiry with 422",
    async () => {
      const { data, error } = await apiClient.api.me.secrets.post(
        // @ts-expect-error -- missing expiresAt on purpose
        {
          kind: "bitbucket_api_token",
          name: `Bitbucket ${crypto.randomUUID()}`,
          email: "me@example.com",
          value: "bitbucket-token",
        },
        { headers },
      );

      expect(data).toBeNull();
      expect(error?.status).toBe(422);
    },
  );

  concurrentTest(
    "rejects a GitHub token carrying an email with 422",
    async () => {
      const { data, error } = await apiClient.api.me.secrets.post(
        // @ts-expect-error -- extra field on purpose
        { ...githubTokenInput(), email: "me@example.com" },
        { headers },
      );

      expect(data).toBeNull();
      expect(error?.status).toBe(422);
    },
  );

  concurrentTest("lists all three kinds and filters by each kind", async () => {
    const user = await createSecretsTestUser();
    const userHeaders = user.authHeaders;
    const jira = await unwrapAsync(
      apiClient.api.me.secrets.post(jiraApiKeyInput(), {
        headers: userHeaders,
      }),
    );
    const github = await unwrapAsync(
      apiClient.api.me.secrets.post(githubTokenInput(), {
        headers: userHeaders,
      }),
    );
    const bitbucket = await unwrapAsync(
      apiClient.api.me.secrets.post(bitbucketApiTokenInput(), {
        headers: userHeaders,
      }),
    );

    const all = await unwrapAsync(
      apiClient.api.me.secrets.get({ headers: userHeaders }),
    );
    const listKind = async (
      kind: "jira_api_key" | "github_token" | "bitbucket_api_token",
    ) =>
      (
        await unwrapAsync(
          apiClient.api.me.secrets.get({
            headers: userHeaders,
            query: { kind },
          }),
        )
      ).map((s) => s.id);

    expect(all.map((s) => s.id)).toEqual([bitbucket.id, github.id, jira.id]);
    expect(await listKind("github_token")).toEqual([github.id]);
    expect(await listKind("bitbucket_api_token")).toEqual([bitbucket.id]);
    expect(await listKind("jira_api_key")).toEqual([jira.id]);
  });

  concurrentTest("allows the same name across different kinds", async () => {
    const name = `Shared ${crypto.randomUUID()}`;

    await unwrapAsync(
      apiClient.api.me.secrets.post(githubTokenInput({ name }), { headers }),
    );
    const { error } = await apiClient.api.me.secrets.post(
      bitbucketApiTokenInput({ name }),
      { headers },
    );

    expect(error).toBeNull();
  });

  concurrentTest("deletes GitHub and Bitbucket tokens", async () => {
    for (const input of [githubTokenInput(), bitbucketApiTokenInput()]) {
      const secret = await unwrapAsync(
        apiClient.api.me.secrets.post(input, { headers }),
      );
      const secretClient = apiClient.api.me.secrets({
        secretId: parseUuidV7(secret.id),
      });

      expect(
        await unwrapAsync(secretClient.delete(undefined, { headers })),
      ).toEqual({ deleted: true });
      const remaining = await unwrapAsync(
        apiClient.api.me.secrets.get({ headers }),
      );
      expect(remaining.map((s) => s.id)).not.toContain(secret.id);
    }
  });
});
