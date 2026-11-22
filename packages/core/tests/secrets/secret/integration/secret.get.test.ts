import { describe, expect } from "bun:test";
import type { TimeProvider } from "@/lib/time-provider";
import { concurrentTest, unwrapAsync } from "tests/utils";
import {
  SECRETS_TEST_NOW,
  createSecretsTestClient,
  createSecretsTestUser,
  daysFromNow,
  jiraApiKeyInput,
} from "./secret-test-support";

const movableTimeProvider = (start: Date) => {
  let now = start;
  const provider: TimeProvider = {
    now: () => now,
    nowIso: () => now.toISOString(),
  };
  return {
    provider,
    set: (next: Date) => {
      now = next;
    },
  };
};

describe("GET /me/secrets", () => {
  concurrentTest("returns 401 without a session", async () => {
    const { data, error } =
      await createSecretsTestClient().api.me.secrets.get();

    expect(data).toBeNull();
    expect(error?.status).toBe(401);
  });

  concurrentTest(
    "returns only the caller's own secrets, newest first",
    async () => {
      const apiClient = createSecretsTestClient();
      const alice = await createSecretsTestUser();
      const bob = await createSecretsTestUser();

      const aliceFirst = await unwrapAsync(
        apiClient.api.me.secrets.post(jiraApiKeyInput(), {
          headers: alice.authHeaders,
        }),
      );
      const aliceSecond = await unwrapAsync(
        apiClient.api.me.secrets.post(jiraApiKeyInput(), {
          headers: alice.authHeaders,
        }),
      );
      const bobs = await unwrapAsync(
        apiClient.api.me.secrets.post(jiraApiKeyInput(), {
          headers: bob.authHeaders,
        }),
      );

      const aliceList = await unwrapAsync(
        apiClient.api.me.secrets.get({ headers: alice.authHeaders }),
      );
      const bobList = await unwrapAsync(
        apiClient.api.me.secrets.get({ headers: bob.authHeaders }),
      );

      expect(aliceList.map((s) => s.id)).toEqual([
        aliceSecond.id,
        aliceFirst.id,
      ]);
      expect(bobList.map((s) => s.id)).toEqual([bobs.id]);
    },
  );

  concurrentTest("filters by kind", async () => {
    const apiClient = createSecretsTestClient();
    const user = await createSecretsTestUser();
    const created = await unwrapAsync(
      apiClient.api.me.secrets.post(jiraApiKeyInput(), {
        headers: user.authHeaders,
      }),
    );

    const filtered = await unwrapAsync(
      apiClient.api.me.secrets.get({
        headers: user.authHeaders,
        query: { kind: "jira_api_key" },
      }),
    );
    const { data, error } = await apiClient.api.me.secrets.get({
      headers: user.authHeaders,
      // @ts-expect-error -- unknown kind on purpose
      query: { kind: "env" },
    });

    expect(filtered.map((s) => s.id)).toEqual([created.id]);
    expect(data).toBeNull();
    expect(error?.status).toBe(422);
  });

  concurrentTest("works out status from the current time", async () => {
    const clock = movableTimeProvider(SECRETS_TEST_NOW);
    const apiClient = createSecretsTestClient(clock.provider);
    const user = await createSecretsTestUser();

    await unwrapAsync(
      apiClient.api.me.secrets.post(
        jiraApiKeyInput({ expiresAt: daysFromNow(30) }),
        { headers: user.authHeaders },
      ),
    );

    const statusAt = async (date: string) => {
      clock.set(new Date(date));
      const [secret] = await unwrapAsync(
        apiClient.api.me.secrets.get({ headers: user.authHeaders }),
      );
      return secret?.status;
    };

    expect(await statusAt(daysFromNow(0))).toBe("active");
    expect(await statusAt(daysFromNow(16))).toBe("expiring_soon");
    expect(await statusAt(daysFromNow(30))).toBe("expired");
  });
});
