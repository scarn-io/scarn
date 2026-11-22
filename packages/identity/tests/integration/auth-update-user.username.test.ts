import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { getIdentityAuth } from "@/lib/auth";
import { createTestUserAndSession } from "./helpers/create-test-user-and-session";

const uniqueUsername = (): string =>
  `user-${randomUUID().replace(/-/g, "").slice(0, 12)}`;

const updateUsername = (bearer: string, username: string) =>
  getIdentityAuth().api.updateUser({
    body: { username },
    headers: new Headers({ authorization: bearer }),
    returnHeaders: true,
  });

// Walks the `cause` chain the way `POST /api/username` does, so this test fails
// for the same reason that route's 409 mapping would.
// eslint-disable-next-line local/no-unknown-parameter-type -- inspects a caught value
const causeChain = (err: unknown): readonly object[] => {
  const chain: object[] = [];
  let current: unknown = err;

  while (typeof current === "object" && current !== null && chain.length < 6) {
    chain.push(current);
    current = "cause" in current ? current.cause : null;
  }

  return chain;
};

/**
 * `POST /api/username` (apps/api) delegates its write to `auth.api.updateUser`
 * and maps a Postgres unique violation on `username` to a 409. That mapping
 * depends on the SHAPE of the rejection, which is not obvious: Better Auth does
 * not translate adapter failures into an `APIError`, and Drizzle wraps the
 * driver error, so the SQLSTATE only ever appears on a NESTED `cause` — never on
 * the thrown error itself. These tests pin that contract down; if a Better Auth
 * or Drizzle upgrade changes it, the route's `isUniqueViolation` needs updating
 * and this fails first.
 */
describe("auth.api.updateUser username writes", () => {
  test.concurrent(
    "returns the refreshed session cookies, including the cookie-cache snapshot",
    async () => {
      const user = await createTestUserAndSession({ username: null });
      const chosen = uniqueUsername();

      const { headers, response } = await updateUsername(
        user.authHeaders.authorization,
        chosen,
      );

      // `updateUser` deliberately does NOT return the user — the route reloads
      // the row instead of trusting this payload.
      expect(response).toEqual({ status: true });

      const setCookies = headers.getSetCookie();
      expect(
        setCookies.some((cookie) =>
          cookie.startsWith("better-auth.session_data="),
        ),
      ).toBe(true);
    },
  );

  test.concurrent(
    "rejects a duplicate username with a nested Postgres unique violation",
    async () => {
      const taken = uniqueUsername();
      await createTestUserAndSession({ username: taken });
      const claimant = await createTestUserAndSession({ username: null });

      let thrown: unknown;
      let rejected = false;
      try {
        await updateUsername(claimant.authHeaders.authorization, taken);
      } catch (err) {
        thrown = err;
        rejected = true;
      }

      expect(rejected).toBe(true);

      const chain = causeChain(thrown);
      // The outer error carries no SQLSTATE — a flat `err.code` check would miss
      // this entirely and the route would answer 500 instead of 409.
      expect(chain[0]).not.toHaveProperty("code");
      expect(
        chain.some(
          (link) =>
            "code" in link &&
            (link as { code?: unknown }).code === "23505" &&
            (link as { constraint?: unknown }).constraint ===
              "identity_user_username_unique",
        ),
      ).toBe(true);
    },
  );
});
