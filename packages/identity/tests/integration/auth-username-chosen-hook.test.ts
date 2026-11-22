import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { getIdentityAuth } from "@/lib/auth";
import { DrizzleAuthUserRepo } from "@/authentication/infra/drizzle-auth-user-repo";
import { createAuthRequest } from "./helpers/auth-test-helpers";
import { createTestUserAndSession } from "./helpers/create-test-user-and-session";

const uniqueUsername = (): string =>
  `user-${randomUUID().replace(/-/g, "").slice(0, 12)}`;

const updateUser = (
  authHeaders: { authorization: string },
  body: Record<string, unknown>,
) =>
  getIdentityAuth().handler(
    createAuthRequest("/update-user", {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders },
      body: JSON.stringify(body),
    }),
  );

// End-to-end proof through Better Auth's own `POST /update-user` route: the
// route cannot accept `usernameChosen` (it is `input: false`), so the flag can
// only reach the row via the `user.update.before` database hook.
describe("update-user derives usernameChosen", () => {
  test.concurrent("flips usernameChosen when a username is set", async () => {
    const { userId, authHeaders } = await createTestUserAndSession({
      username: null,
    });
    const chosen = uniqueUsername();

    const before = await new DrizzleAuthUserRepo().load(userId);
    expect(before?.username).toBeNull();
    expect(before?.usernameChosen).toBe(false);

    const response = await updateUser(authHeaders, { username: chosen });
    expect(response.status).toBe(200);

    const after = await new DrizzleAuthUserRepo().load(userId);
    expect(after?.username).toBe(chosen);
    expect(after?.usernameChosen).toBe(true);
  });

  test.concurrent(
    "leaves usernameChosen false for an update that does not set a username",
    async () => {
      const { userId, authHeaders } = await createTestUserAndSession({
        username: null,
      });

      const response = await updateUser(authHeaders, { name: "Renamed User" });
      expect(response.status).toBe(200);

      const after = await new DrizzleAuthUserRepo().load(userId);
      expect(after?.name).toBe("Renamed User");
      expect(after?.username).toBeNull();
      expect(after?.usernameChosen).toBe(false);
    },
  );

  // A rename is the one path where the hook could regress an already-onboarded
  // user: it re-derives `usernameChosen` on every write that carries a username,
  // so it has to land on `true` for a user who was already onboarded rather than
  // resetting them into onboarding.
  test.concurrent(
    "renames an already-onboarded user without regressing usernameChosen",
    async () => {
      const first = uniqueUsername();
      const { userId, authHeaders } = await createTestUserAndSession({
        username: first,
      });
      const repo = new DrizzleAuthUserRepo();

      const before = await repo.load(userId);
      expect(before?.username).toBe(first);
      expect(before?.usernameChosen).toBe(true);

      const renamed = uniqueUsername();
      const response = await updateUser(authHeaders, { username: renamed });
      expect(response.status).toBe(200);

      const after = await repo.load(userId);
      expect(after?.username).toBe(renamed);
      expect(after?.usernameChosen).toBe(true);

      // The old handle is immediately free again (no tombstone row).
      expect(await repo.isUsernameTaken(first)).toBe(false);
      expect(await repo.isUsernameTaken(renamed)).toBe(true);
    },
  );

  test.concurrent(
    "rejects a client-supplied usernameChosen, so the hook is the only way it is set",
    async () => {
      const { userId, authHeaders } = await createTestUserAndSession({
        username: null,
      });

      const response = await updateUser(authHeaders, {
        username: uniqueUsername(),
        usernameChosen: true,
      });
      expect(response.status).toBe(400);

      const after = await new DrizzleAuthUserRepo().load(userId);
      expect(after?.username).toBeNull();
      expect(after?.usernameChosen).toBe(false);
    },
  );
});
