import { afterEach, describe, expect, test } from "bun:test";
import { createIdentityAuth } from "@/lib/auth";

const sessionCookieAttributes = async () =>
  (await createIdentityAuth().$context).authCookies.sessionToken.attributes;

describe("session cookie domain", () => {
  const originalCookieDomain = process.env["BETTER_AUTH_COOKIE_DOMAIN"];

  afterEach(() => {
    if (originalCookieDomain === undefined) {
      delete process.env["BETTER_AUTH_COOKIE_DOMAIN"];
    } else {
      process.env["BETTER_AUTH_COOKIE_DOMAIN"] = originalCookieDomain;
    }
  });

  test("shares session cookies across subdomains when a domain is set", async () => {
    process.env["BETTER_AUTH_COOKIE_DOMAIN"] = "scarn.example.test";

    expect((await sessionCookieAttributes()).domain).toBe("scarn.example.test");
  });

  test("keeps host-only session cookies when no domain is set", async () => {
    delete process.env["BETTER_AUTH_COOKIE_DOMAIN"];

    expect((await sessionCookieAttributes()).domain).toBeUndefined();
  });
});
