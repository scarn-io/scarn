import { afterEach, describe, expect, test } from "bun:test";
import { createIdentityAuth } from "@/lib/auth";

const emailAndPasswordOptions = async () =>
  (await createIdentityAuth().$context).options.emailAndPassword;

describe("email/password sign-in", () => {
  const original = process.env["ENABLE_EMAIL_PASSWORD_LOGIN"];

  afterEach(() => {
    if (original === undefined) {
      delete process.env["ENABLE_EMAIL_PASSWORD_LOGIN"];
    } else {
      process.env["ENABLE_EMAIL_PASSWORD_LOGIN"] = original;
    }
  });

  test("is enabled without email verification by default", async () => {
    delete process.env["ENABLE_EMAIL_PASSWORD_LOGIN"];

    expect(await emailAndPasswordOptions()).toMatchObject({
      enabled: true,
      requireEmailVerification: false,
    });
  });

  test("is disabled when ENABLE_EMAIL_PASSWORD_LOGIN=false", async () => {
    process.env["ENABLE_EMAIL_PASSWORD_LOGIN"] = "false";

    expect((await emailAndPasswordOptions()).enabled).toBe(false);
  });
});
