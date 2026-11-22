import { beforeAll, describe, expect } from "bun:test";
import { createUuidV7, parseUuidV7 } from "@/common/contracts/uuid-v7";
import { concurrentTest, unwrapAsync } from "tests/utils";
import {
  createSecretsTestClient,
  createSecretsTestUser,
  jiraApiKeyInput,
} from "./secret-test-support";

describe("DELETE /me/secrets/:secretId", () => {
  const apiClient = createSecretsTestClient();
  let headers: { authorization: string };

  beforeAll(async () => {
    headers = (await createSecretsTestUser()).authHeaders;
  });

  concurrentTest("returns 401 without a session", async () => {
    const { error } = await apiClient.api.me
      .secrets({ secretId: createUuidV7() })
      .delete();

    expect(error?.status).toBe(401);
  });

  concurrentTest(
    "returns 404 for another user's secret and leaves it in place",
    async () => {
      const secret = await unwrapAsync(
        apiClient.api.me.secrets.post(jiraApiKeyInput(), { headers }),
      );
      const other = await createSecretsTestUser();

      const { data, error } = await apiClient.api.me
        .secrets({ secretId: parseUuidV7(secret.id) })
        .delete(undefined, { headers: other.authHeaders });
      const ownerList = await unwrapAsync(
        apiClient.api.me.secrets.get({ headers }),
      );

      expect(data).toBeNull();
      expect(error?.status).toBe(404);
      expect(error?.value).toMatchObject({ code: "SECRET_NOT_FOUND" });
      expect(ownerList.map((s) => s.id)).toContain(secret.id);
    },
  );

  concurrentTest(
    "returns 404 for a missing or already deleted secret",
    async () => {
      const secret = await unwrapAsync(
        apiClient.api.me.secrets.post(jiraApiKeyInput(), { headers }),
      );
      const secretClient = apiClient.api.me.secrets({
        secretId: parseUuidV7(secret.id),
      });

      await unwrapAsync(secretClient.delete(undefined, { headers }));
      const { error } = await secretClient.delete(undefined, { headers });

      expect(error?.status).toBe(404);
    },
  );
});
