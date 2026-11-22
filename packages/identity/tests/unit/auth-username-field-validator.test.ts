import { describe, expect, test } from "bun:test";
import { parseUserInput } from "better-auth/db";
import { getIdentityAuth } from "@/lib/auth";

// `parseUserInput` is the exact function Better Auth's own
// `POST /api/auth/update-user` route calls to sanitize the request body
// (see better-auth/dist/api/routes/update-user.mjs). Driving it with the real
// auth instance's options proves the field-level validator is actually wired
// up, rather than re-testing `usernameSchema` in isolation.
const parseUsernameUpdate = (username: string | null): unknown =>
  parseUserInput(getIdentityAuth().options, { username }, "update");

describe("username additional field validator", () => {
  test("rejects a reserved username", () => {
    expect(() => parseUsernameUpdate("admin")).toThrow("Username is reserved");
  });

  test("rejects a malformed username", () => {
    expect(() => parseUsernameUpdate("BAD__Name!!")).toThrow(
      "Username must be lowercase letters, numbers, or single interior hyphens",
    );
  });

  test("rejects a username below the minimum length", () => {
    expect(() => parseUsernameUpdate("ab")).toThrow();
  });

  test("accepts a valid username and applies the trim/lowercase transform", () => {
    expect(parseUsernameUpdate("  Good-Name  ")).toEqual({
      username: "good-name",
    });
  });

  test("accepts null so OAuth signup can create a row without a handle", () => {
    expect(parseUsernameUpdate(null)).toEqual({ username: null });
  });
});
