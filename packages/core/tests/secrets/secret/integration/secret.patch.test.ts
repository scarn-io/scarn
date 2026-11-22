import { beforeAll, describe, expect } from "bun:test";
import { createUuidV7, parseUuidV7 } from "@/common/contracts/uuid-v7";
import { concurrentTest, unwrapAsync } from "tests/utils";
import {
  createSecretsTestClient,
  createSecretsTestUser,
  jiraApiKeyInput,
} from "./secret-test-support";

describe("PATCH /me/secrets/:secretId", () => {
  const apiClient = createSecretsTestClient();
  let headers: { authorization: string };

  beforeAll(async () => {
    headers = (await createSecretsTestUser()).authHeaders;
  });

  const createSecret = async (name?: string) =>
    await unwrapAsync(
      apiClient.api.me.secrets.post(jiraApiKeyInput(name ? { name } : {}), {
        headers,
      }),
    );

  concurrentTest("renames the caller's secret and trims the name", async () => {
    const secret = await createSecret();

    const renamed = await unwrapAsync(
      apiClient.api.me
        .secrets({ secretId: parseUuidV7(secret.id) })
        .patch({ name: "  Renamed  " }, { headers }),
    );

    expect(renamed.name).toBe("Renamed");
    expect(renamed.metadata).toEqual(secret.metadata);
    expect(renamed.lastFour).toBe(secret.lastFour);
  });

  concurrentTest("returns 404 for another user's secret", async () => {
    const secret = await createSecret();
    const other = await createSecretsTestUser();

    const { data, error } = await apiClient.api.me
      .secrets({ secretId: parseUuidV7(secret.id) })
      .patch({ name: "Stolen" }, { headers: other.authHeaders });

    expect(data).toBeNull();
    expect(error?.status).toBe(404);
    expect(error?.value).toMatchObject({ code: "SECRET_NOT_FOUND" });
  });

  concurrentTest("returns 404 for a missing secret", async () => {
    const { error } = await apiClient.api.me
      .secrets({ secretId: createUuidV7() })
      .patch({ name: "Nothing" }, { headers });

    expect(error?.status).toBe(404);
  });

  concurrentTest(
    "returns 409 when renaming onto another of the caller's names",
    async () => {
      const taken = `Taken ${crypto.randomUUID()}`;
      await createSecret(taken);
      const secret = await createSecret();

      const { error } = await apiClient.api.me
        .secrets({ secretId: parseUuidV7(secret.id) })
        .patch({ name: taken }, { headers });

      expect(error?.status).toBe(409);
      expect(error?.value).toMatchObject({ code: "SECRET_NAME_TAKEN" });
    },
  );

  concurrentTest(
    "rejects an empty name and any other field with 422",
    async () => {
      const secret = await createSecret();
      const secretClient = apiClient.api.me.secrets({
        secretId: parseUuidV7(secret.id),
      });

      const empty = await secretClient.patch({ name: "   " }, { headers });
      const extra = await secretClient.patch(
        // @ts-expect-error -- the value can't be changed, only the name
        { name: "New", value: "new-token" },
        { headers },
      );

      expect(empty.error?.status).toBe(422);
      expect(extra.error?.status).toBe(422);
    },
  );
});
