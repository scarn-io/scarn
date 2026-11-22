import { spyOn } from "bun:test";
import { getIdentityAuth } from "@scarn/identity";
import { createUuidV7 } from "@scarn/core/common/contracts/uuid-v7";

export const SESSION_EMAIL_HEADER = "x-test-user-email";

export const REQUIRED_AUTH_ENV = {
  DATABASE_URL: "postgres://test:test@localhost:5432/test",
  BETTER_AUTH_SECRET: "test-better-auth-secret-0123456789abcdef",
  BETTER_AUTH_URL: "http://localhost:3000",
} as const;

export const restoreEnv = (key: string, value: string | undefined) => {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
  } else {
    process.env[key] = value;
  }
};

/**
 * Replaces Better Auth's `getSession` so a request carrying
 * {@link SESSION_EMAIL_HEADER} is signed in as that email, and any other
 * request has no session. Undo with `mock.restore()`.
 */
export const fakeSessionFromEmailHeader = () =>
  spyOn(getIdentityAuth().api, "getSession").mockImplementation((({
    headers,
  }: {
    headers: Headers;
  }) => {
    const email = headers.get(SESSION_EMAIL_HEADER);
    if (!email) {
      return Promise.resolve(null);
    }
    const userId = createUuidV7();
    return Promise.resolve({
      user: { id: userId, email },
      session: { id: "session-1", userId },
    });
  }) as never);
