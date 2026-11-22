import { beforeAll, describe, expect, test } from "bun:test";
import { parseUuidV7 } from "@/common/contracts/uuid-v7";
import type { SecretContract } from "@/secrets/secret/contracts/secret-contracts";
import { unwrapAsync } from "tests/utils";
import {
  createSecretsTestClient,
  createSecretsTestUser,
  jiraApiKeyInput,
} from "./secret-test-support";

describe("secret lifecycle", () => {
  const apiClient = createSecretsTestClient();
  let headers: { authorization: string };
  let secret: SecretContract;

  beforeAll(async () => {
    headers = (await createSecretsTestUser()).authHeaders;
  });

  test("creates a Jira API key", async () => {
    secret = await unwrapAsync(
      apiClient.api.me.secrets.post(
        jiraApiKeyInput({ name: "Work Jira", value: "token-1234" }),
        { headers },
      ),
    );

    expect(secret.name).toBe("Work Jira");
    expect(secret.lastFour).toBe("1234");
    expect(secret.status).toBe("active");
  });

  test("lists it", async () => {
    const secrets = await unwrapAsync(
      apiClient.api.me.secrets.get({ headers }),
    );

    expect(secrets.map((s) => s.id)).toEqual([secret.id]);
  });

  test("renames it", async () => {
    const renamed = await unwrapAsync(
      apiClient.api.me
        .secrets({ secretId: parseUuidV7(secret.id) })
        .patch({ name: "Personal Jira" }, { headers }),
    );

    expect(renamed.id).toBe(secret.id);
    expect(renamed.name).toBe("Personal Jira");
  });

  test("deletes it", async () => {
    const deleted = await unwrapAsync(
      apiClient.api.me
        .secrets({ secretId: parseUuidV7(secret.id) })
        .delete(undefined, { headers }),
    );

    expect(deleted).toEqual({ deleted: true });
  });

  test("no longer lists it", async () => {
    const secrets = await unwrapAsync(
      apiClient.api.me.secrets.get({ headers }),
    );

    expect(secrets).toEqual([]);
  });
});
