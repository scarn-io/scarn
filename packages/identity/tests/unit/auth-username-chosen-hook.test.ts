import { describe, expect, test } from "bun:test";
import type { BetterAuthOptions, User } from "better-auth";
import { getIdentityAuth } from "@/lib/auth";

// Reads the hook straight off the real auth options, so this proves the hook is
// actually wired into `databaseHooks.user.update` — not just that some local
// function behaves. Widening to `BetterAuthOptions` first pins the call to
// Better Auth's declared hook signature, which is what `updateWithHooks`
// invokes: `(data, context)`, with a returned `{ data }` merged into the
// pending update and `undefined` leaving it untouched.
const runUpdateHook = async (data: Partial<User> & Record<string, unknown>) => {
  const options: BetterAuthOptions = getIdentityAuth().options;
  const before = options.databaseHooks?.user?.update?.before;
  if (!before) {
    throw new Error("databaseHooks.user.update.before is not configured");
  }

  return before(data, null);
};

describe("user.update.before usernameChosen hook", () => {
  test("marks usernameChosen when a username is set", async () => {
    expect(await runUpdateHook({ username: "chosen-name" })).toEqual({
      data: { username: "chosen-name", usernameChosen: true },
    });
  });

  test("keeps the rest of the update intact", async () => {
    expect(
      await runUpdateHook({ username: "chosen-name", name: "New Name" }),
    ).toEqual({
      data: { username: "chosen-name", name: "New Name", usernameChosen: true },
    });
  });

  test("is idempotent for a rename, where the flag is already true", async () => {
    expect(
      await runUpdateHook({ username: "renamed", usernameChosen: true }),
    ).toEqual({
      data: { username: "renamed", usernameChosen: true },
    });
  });

  // `undefined` leaves the pending update untouched, so a write that does not
  // set a username can never flip the onboarding flag.
  test("leaves the update untouched when username is absent", async () => {
    expect(await runUpdateHook({ name: "New Name" })).toBeUndefined();
  });

  test("leaves the update untouched for an empty username", async () => {
    expect(await runUpdateHook({ username: "" })).toBeUndefined();
  });

  test("leaves the update untouched for a null username", async () => {
    expect(await runUpdateHook({ username: null })).toBeUndefined();
  });
});
