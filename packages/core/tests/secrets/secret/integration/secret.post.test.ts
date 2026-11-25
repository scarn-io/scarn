import { beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { secrets } from "@/lib/db/schema";
import { concurrentTest, unwrapAsync } from "tests/utils";
import {
  createSecretsTestClient,
  createSecretsTestUser,
  daysFromNow,
  jiraApiKeyInput,
} from "./secret-test-support";

describe("POST /me/secrets", () => {
  const apiClient = createSecretsTestClient();
  let headers: { authorization: string };

  beforeAll(async () => {
    headers = (await createSecretsTestUser()).authHeaders;
  });

  concurrentTest("returns 401 without a session", async () => {
    const { data, error } =
      await apiClient.api.me.secrets.post(jiraApiKeyInput());

    expect(data).toBeNull();
    expect(error?.status).toBe(401);
  });

  test("creates a Jira API key without ever returning its value", async () => {
    const value = "  atlassian-token-SECRET-wxyz  ";
    const { data, error, status } = await apiClient.api.me.secrets.post(
      jiraApiKeyInput({
        name: "  Work Jira  ",
        email: "  Me@Example.COM ",
        value,
        expiresAt: daysFromNow(90),
      }),
      { headers },
    );

    expect(error).toBeNull();
    expect(status).toBe(201);
    expect(JSON.stringify(data)).not.toContain("atlassian-token-SECRET");
    if (!data) throw new Error("expected a created secret");
    const { id, createdAt, updatedAt, ...stable } = data;
    expect(typeof id).toBe("string");
    expect(typeof createdAt).toBe("string");
    expect(updatedAt).toBe(createdAt);
    expect(stable).toMatchInlineSnapshot(`
      {
        "expiresAt": "2027-01-18T12:00:00.000Z",
        "kind": "jira_api_key",
        "lastFour": "wxyz",
        "lastUsedAt": null,
        "metadata": {
          "email": "me@example.com",
        },
        "name": "Work Jira",
        "status": "active",
      }
    `);
  });

  concurrentTest("stores the value encrypted, not as plain text", async () => {
    const value = `plaintext-marker-${crypto.randomUUID()}`;
    const created = await unwrapAsync(
      apiClient.api.me.secrets.post(jiraApiKeyInput({ value }), { headers }),
    );

    const [row] = await getDb()
      .select()
      .from(secrets)
      .where(eq(secrets.id, created.id));

    expect(row).toBeDefined();
    expect(row?.ciphertext.length).toBeGreaterThan(0);
    expect(Buffer.from(row?.ciphertext ?? []).toString("utf8")).not.toContain(
      value,
    );
    expect(
      Buffer.from(row?.ciphertext ?? []).includes(Buffer.from(value, "utf8")),
    ).toBe(false);
    expect(JSON.stringify(row?.metadataJson)).not.toContain(value);
    expect(row?.lastFour).toBe(value.slice(-4));
  });

  concurrentTest("rejects an invalid email with 422", async () => {
    const { data, error } = await apiClient.api.me.secrets.post(
      jiraApiKeyInput({ email: "not-an-email" }),
      { headers },
    );

    expect(data).toBeNull();
    expect(error?.status).toBe(422);
  });

  concurrentTest("rejects an expiry in the past with 422", async () => {
    const { data, error } = await apiClient.api.me.secrets.post(
      jiraApiKeyInput({ expiresAt: daysFromNow(-1) }),
      { headers },
    );

    expect(data).toBeNull();
    expect(error?.status).toBe(422);
    expect(error?.value).toMatchObject({ code: "SECRET_EXPIRY_IN_PAST" });
  });

  concurrentTest(
    "rejects a duplicate name for the same kind with 409",
    async () => {
      const input = jiraApiKeyInput();
      await unwrapAsync(apiClient.api.me.secrets.post(input, { headers }));

      const { data, error } = await apiClient.api.me.secrets.post(
        { ...input, value: "another-token" },
        { headers },
      );

      expect(data).toBeNull();
      expect(error?.status).toBe(409);
      expect(error?.value).toMatchObject({ code: "SECRET_NAME_TAKEN" });
      expect(JSON.stringify(error?.value)).not.toContain("another-token");
    },
  );

  concurrentTest("allows the same name for different users", async () => {
    const other = await createSecretsTestUser();
    const input = jiraApiKeyInput();
    await unwrapAsync(apiClient.api.me.secrets.post(input, { headers }));

    const { error } = await apiClient.api.me.secrets.post(input, {
      headers: other.authHeaders,
    });

    expect(error).toBeNull();
  });

  concurrentTest("rejects an unknown kind with 422", async () => {
    const { data, error } = await apiClient.api.me.secrets.post(
      // @ts-expect-error -- unknown kind on purpose
      { ...jiraApiKeyInput(), kind: "env" },
      { headers },
    );

    expect(data).toBeNull();
    expect(error?.status).toBe(422);
  });

  concurrentTest("rejects an over-long value with 422", async () => {
    const value = "x".repeat(4097);
    const { data, error } = await apiClient.api.me.secrets.post(
      jiraApiKeyInput({ value }),
      { headers },
    );

    expect(data).toBeNull();
    expect(error?.status).toBe(422);
    expect(JSON.stringify(error?.value)).not.toContain(value);
  });
});
