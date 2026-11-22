import { describe, expect, test } from "bun:test";
import {
  BOOTSTRAP_COOKIE_NAME,
  buildBootstrapCookieDeletion,
  hasPosthogCookie,
  readBootstrapCookie,
} from "../../src/analytics/bootstrap-cookie";

const ID = "0190f3a2-7c1e-7a4b-9d2e-3f5a6b7c8d9e";

describe("readBootstrapCookie", () => {
  test.concurrent("reads the distinct id when it is the only cookie", () => {
    expect(readBootstrapCookie(`${BOOTSTRAP_COOKIE_NAME}=${ID}`)).toEqual({
      present: true,
      distinctId: ID,
    });
  });

  test.concurrent("finds the cookie among many others", () => {
    const cookies = `a=1; theme=dark; ${BOOTSTRAP_COOKIE_NAME}=${ID}; ph_phc_posthog=%7B%7D; z=9`;
    expect(readBootstrapCookie(cookies)).toEqual({
      present: true,
      distinctId: ID,
    });
  });

  test.concurrent("decodes a url-encoded value", () => {
    expect(
      readBootstrapCookie(`${BOOTSTRAP_COOKIE_NAME}=anon%3A${ID}`),
    ).toEqual({ present: true, distinctId: `anon:${ID}` });
  });

  test.concurrent("reports an absent cookie", () => {
    expect(readBootstrapCookie("a=1; b=2")).toEqual({
      present: false,
      distinctId: null,
    });
    expect(readBootstrapCookie("")).toEqual({
      present: false,
      distinctId: null,
    });
    expect(readBootstrapCookie(undefined)).toEqual({
      present: false,
      distinctId: null,
    });
  });

  test.concurrent(
    "does not match cookies that only share a prefix or suffix",
    () => {
      expect(
        readBootstrapCookie(
          `x${BOOTSTRAP_COOKIE_NAME}=${ID}; ${BOOTSTRAP_COOKIE_NAME}x=${ID}`,
        ),
      ).toEqual({ present: false, distinctId: null });
    },
  );

  test.concurrent("treats an empty value as present but unusable", () => {
    expect(readBootstrapCookie(`${BOOTSTRAP_COOKIE_NAME}=`)).toEqual({
      present: true,
      distinctId: null,
    });
    expect(readBootstrapCookie(`${BOOTSTRAP_COOKIE_NAME}=%20%20`)).toEqual({
      present: true,
      distinctId: null,
    });
  });

  test.concurrent("treats a malformed escape as present but unusable", () => {
    expect(readBootstrapCookie(`${BOOTSTRAP_COOKIE_NAME}=%E0%A4%A`)).toEqual({
      present: true,
      distinctId: null,
    });
  });

  test.concurrent("falls back to a later usable duplicate", () => {
    expect(
      readBootstrapCookie(
        `${BOOTSTRAP_COOKIE_NAME}=; ${BOOTSTRAP_COOKIE_NAME}=${ID}`,
      ),
    ).toEqual({ present: true, distinctId: ID });
  });

  test.concurrent("keeps '=' characters inside the value", () => {
    expect(readBootstrapCookie(`${BOOTSTRAP_COOKIE_NAME}=a=b`)).toEqual({
      present: true,
      distinctId: "a=b",
    });
  });
});

describe("hasPosthogCookie", () => {
  test.concurrent("detects the project's persisted posthog cookie", () => {
    expect(hasPosthogCookie("a=1; ph_phc_abc_posthog=%7B%7D", "phc_abc")).toBe(
      true,
    );
  });

  test.concurrent("ignores other projects and missing cookies", () => {
    expect(hasPosthogCookie("ph_phc_other_posthog=%7B%7D", "phc_abc")).toBe(
      false,
    );
    expect(hasPosthogCookie("", "phc_abc")).toBe(false);
    expect(hasPosthogCookie(undefined, "phc_abc")).toBe(false);
  });
});

describe("buildBootstrapCookieDeletion", () => {
  test.concurrent("scopes to the configured parent domain over https", () => {
    expect(
      buildBootstrapCookieDeletion({
        hostname: "example.com",
        protocol: "https:",
        cookieDomain: "example.com",
      }),
    ).toBe(
      `${BOOTSTRAP_COOKIE_NAME}=; Domain=.example.com; Path=/; Max-Age=0; Secure; SameSite=Lax`,
    );
  });

  test.concurrent(
    "uses the parent domain on every subdomain of the configured domain",
    () => {
      for (const hostname of [
        "app.example.com",
        "docs.example.com",
        "A.Example.Com",
      ]) {
        expect(
          buildBootstrapCookieDeletion({
            hostname,
            protocol: "https:",
            cookieDomain: ".Example.com ",
          }),
        ).toContain("Domain=.example.com");
      }
    },
  );

  test.concurrent("is host-only when no cookie domain is configured", () => {
    for (const cookieDomain of [undefined, null, "", "  "]) {
      expect(
        buildBootstrapCookieDeletion({
          hostname: "app.example.com",
          protocol: "https:",
          cookieDomain,
        }),
      ).not.toContain("Domain=");
    }
  });

  test.concurrent("is host-only on localhost over http", () => {
    expect(
      buildBootstrapCookieDeletion({
        hostname: "localhost",
        protocol: "http:",
        cookieDomain: "example.com",
      }),
    ).toBe(`${BOOTSTRAP_COOKIE_NAME}=; Path=/; Max-Age=0; SameSite=Lax`);
  });

  test.concurrent("is host-only on hosts outside the configured domain", () => {
    for (const hostname of [
      "example-git-feat.vercel.app",
      "evilexample.com",
      "example.com.attacker.test",
    ]) {
      const cookie = buildBootstrapCookieDeletion({
        hostname,
        protocol: "https:",
        cookieDomain: "example.com",
      });
      expect(cookie).not.toContain("Domain=");
      expect(cookie).toContain("Secure");
    }
  });
});
