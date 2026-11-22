import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createAuthId } from "@/authentication/domain/auth-id";
import { AuthUserEntity } from "@/authentication/domain/auth-user-entity";
import { DrizzleAuthUserRepo } from "@/authentication/infra/drizzle-auth-user-repo";

const uniqueUsername = (): string =>
  `user-${randomUUID().replace(/-/g, "").slice(0, 12)}`;

const uniqueEmail = (): string => `test-${randomUUID()}@example.com`;

const saveUser = async (
  repo: DrizzleAuthUserRepo,
  overrides: { username?: string; usernameChosen?: boolean } = {},
): Promise<AuthUserEntity> =>
  repo.save(
    new AuthUserEntity(
      createAuthId(),
      uniqueEmail(),
      overrides.username ?? uniqueUsername(),
      "Test User",
      true,
      overrides.usernameChosen ?? false,
    ),
  );

describe("DrizzleAuthUserRepo username persistence", () => {
  test.concurrent(
    "persists usernameChosen and round-trips it via load",
    async () => {
      const repo = new DrizzleAuthUserRepo();
      const saved = await saveUser(repo, { usernameChosen: false });

      expect(saved.usernameChosen).toBe(false);

      const loaded = await repo.load(saved.id);
      expect(loaded).not.toBeNull();
      expect(loaded?.usernameChosen).toBe(false);
    },
  );

  test.concurrent(
    "isUsernameTaken and loadByUsername reflect a persisted username",
    async () => {
      const repo = new DrizzleAuthUserRepo();
      const chosen = uniqueUsername();

      expect(await repo.isUsernameTaken(chosen)).toBe(false);

      const saved = await saveUser(repo, { username: chosen });

      expect(await repo.isUsernameTaken(chosen)).toBe(true);
      const byUsername = await repo.loadByUsername(chosen);
      expect(byUsername?.id).toBe(saved.id);
    },
  );

  // `save` is an upsert, so it could otherwise revert a handle claimed through
  // `POST /username` — which writes via Better Auth specifically so the signed
  // session snapshot is refreshed alongside the row. A revert here would bypass
  // that and leave the onboarding gate reading a stale snapshot.
  test.concurrent(
    "re-saving an existing user preserves the claimed username",
    async () => {
      const repo = new DrizzleAuthUserRepo();
      const claimed = uniqueUsername();
      const saved = await saveUser(repo, {
        username: claimed,
        usernameChosen: true,
      });

      const resaved = await repo.save(
        new AuthUserEntity(
          saved.id,
          saved.email,
          uniqueUsername(),
          "Renamed Display Name",
          true,
          // A stale entity would drag the onboarding flag back to false.
          false,
          null,
        ),
      );

      // Preserved, and reported truthfully rather than echoing the input back.
      expect(resaved.username).toBe(claimed);
      expect(resaved.usernameChosen).toBe(true);
      // Everything else still updates.
      expect(resaved.name).toBe("Renamed Display Name");

      const loaded = await repo.load(saved.id);
      expect(loaded?.username).toBe(claimed);
      expect(loaded?.usernameChosen).toBe(true);
      expect(loaded?.name).toBe("Renamed Display Name");
    },
  );

  test.concurrent(
    "re-saving cannot revert a claimed username to null",
    async () => {
      const repo = new DrizzleAuthUserRepo();
      const claimed = uniqueUsername();
      const saved = await saveUser(repo, {
        username: claimed,
        usernameChosen: true,
      });

      await repo.save(
        new AuthUserEntity(
          saved.id,
          saved.email,
          null,
          saved.name,
          true,
          false,
          null,
        ),
      );

      const loaded = await repo.load(saved.id);
      expect(loaded?.username).toBe(claimed);
      expect(loaded?.usernameChosen).toBe(true);
      // The handle stays claimed, so it is still not available to anyone else.
      expect(await repo.isUsernameTaken(claimed)).toBe(true);
    },
  );
});
