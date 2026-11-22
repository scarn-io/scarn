import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  getAppUrl,
  getBetterAuthBaseUrl,
  getBetterAuthCookieDomain,
  getEmailPasswordLoginEnabled,
  getGitHubAppOAuthConfig,
  getGoogleOAuthConfig,
} from "@/lib/env";

describe("getBetterAuthBaseUrl", () => {
  const originalBetterAuthUrl = process.env["BETTER_AUTH_URL"];
  const originalVercelUrl = process.env["VERCEL_URL"];

  beforeEach(() => {
    delete process.env["BETTER_AUTH_URL"];
    delete process.env["VERCEL_URL"];
  });

  afterEach(() => {
    if (originalBetterAuthUrl === undefined) {
      delete process.env["BETTER_AUTH_URL"];
    } else {
      process.env["BETTER_AUTH_URL"] = originalBetterAuthUrl;
    }

    if (originalVercelUrl === undefined) {
      delete process.env["VERCEL_URL"];
    } else {
      process.env["VERCEL_URL"] = originalVercelUrl;
    }
  });

  it("returns the trimmed Better Auth URL", () => {
    process.env["BETTER_AUTH_URL"] = "  https://app.example.test  ";

    expect(getBetterAuthBaseUrl()).toBe("https://app.example.test");
  });

  it("throws when Better Auth URL is unset, ignoring VERCEL_URL", () => {
    process.env["VERCEL_URL"] = "preview.example.vercel.app";

    expect(() => getBetterAuthBaseUrl()).toThrow(
      "Missing required environment variable. Tried: BETTER_AUTH_URL",
    );
  });
});

describe("getGitHubAppOAuthConfig", () => {
  const originalClientId = process.env["GITHUB_APP_CLIENT_ID"];
  const originalClientSecret = process.env["GITHUB_APP_CLIENT_SECRET"];

  beforeEach(() => {
    delete process.env["GITHUB_APP_CLIENT_ID"];
    delete process.env["GITHUB_APP_CLIENT_SECRET"];
  });

  afterEach(() => {
    if (originalClientId === undefined) {
      delete process.env["GITHUB_APP_CLIENT_ID"];
    } else {
      process.env["GITHUB_APP_CLIENT_ID"] = originalClientId;
    }

    if (originalClientSecret === undefined) {
      delete process.env["GITHUB_APP_CLIENT_SECRET"];
    } else {
      process.env["GITHUB_APP_CLIENT_SECRET"] = originalClientSecret;
    }
  });

  it("returns the config when both vars are set", () => {
    process.env["GITHUB_APP_CLIENT_ID"] = "test-client-id";
    process.env["GITHUB_APP_CLIENT_SECRET"] = "test-client-secret";

    expect(getGitHubAppOAuthConfig()).toEqual({
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
    });
  });

  it("trims surrounding whitespace from both vars", () => {
    process.env["GITHUB_APP_CLIENT_ID"] = "  spaced-client-id  ";
    process.env["GITHUB_APP_CLIENT_SECRET"] = "\tspaced-secret\n";

    expect(getGitHubAppOAuthConfig()).toEqual({
      clientId: "spaced-client-id",
      clientSecret: "spaced-secret",
    });
  });

  it("returns null when neither var is set", () => {
    expect(getGitHubAppOAuthConfig()).toBeNull();
  });

  it("returns null when only the client id is set", () => {
    process.env["GITHUB_APP_CLIENT_ID"] = "only-id";

    expect(getGitHubAppOAuthConfig()).toBeNull();
  });

  it("returns null when only the client secret is set", () => {
    process.env["GITHUB_APP_CLIENT_SECRET"] = "only-secret";

    expect(getGitHubAppOAuthConfig()).toBeNull();
  });

  it("treats whitespace-only values as missing", () => {
    process.env["GITHUB_APP_CLIENT_ID"] = "   ";
    process.env["GITHUB_APP_CLIENT_SECRET"] = "\t\n";

    expect(getGitHubAppOAuthConfig()).toBeNull();
  });
});

describe("getGoogleOAuthConfig", () => {
  const originalClientId = process.env["GOOGLE_OAUTH_CLIENT_ID"];
  const originalClientSecret = process.env["GOOGLE_OAUTH_CLIENT_SECRET"];

  beforeEach(() => {
    delete process.env["GOOGLE_OAUTH_CLIENT_ID"];
    delete process.env["GOOGLE_OAUTH_CLIENT_SECRET"];
  });

  afterEach(() => {
    if (originalClientId === undefined) {
      delete process.env["GOOGLE_OAUTH_CLIENT_ID"];
    } else {
      process.env["GOOGLE_OAUTH_CLIENT_ID"] = originalClientId;
    }

    if (originalClientSecret === undefined) {
      delete process.env["GOOGLE_OAUTH_CLIENT_SECRET"];
    } else {
      process.env["GOOGLE_OAUTH_CLIENT_SECRET"] = originalClientSecret;
    }
  });

  it("returns the config when both vars are set", () => {
    process.env["GOOGLE_OAUTH_CLIENT_ID"] = "test-client-id";
    process.env["GOOGLE_OAUTH_CLIENT_SECRET"] = "test-client-secret";

    expect(getGoogleOAuthConfig()).toEqual({
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
    });
  });

  it("trims surrounding whitespace from both vars", () => {
    process.env["GOOGLE_OAUTH_CLIENT_ID"] = "  spaced-client-id  ";
    process.env["GOOGLE_OAUTH_CLIENT_SECRET"] = "\tspaced-secret\n";

    expect(getGoogleOAuthConfig()).toEqual({
      clientId: "spaced-client-id",
      clientSecret: "spaced-secret",
    });
  });

  it("returns null when neither var is set", () => {
    expect(getGoogleOAuthConfig()).toBeNull();
  });

  it("returns null when only the client id is set", () => {
    process.env["GOOGLE_OAUTH_CLIENT_ID"] = "only-id";

    expect(getGoogleOAuthConfig()).toBeNull();
  });

  it("returns null when only the client secret is set", () => {
    process.env["GOOGLE_OAUTH_CLIENT_SECRET"] = "only-secret";

    expect(getGoogleOAuthConfig()).toBeNull();
  });

  it("treats whitespace-only values as missing", () => {
    process.env["GOOGLE_OAUTH_CLIENT_ID"] = "   ";
    process.env["GOOGLE_OAUTH_CLIENT_SECRET"] = "\t\n";

    expect(getGoogleOAuthConfig()).toBeNull();
  });
});

describe("getAppUrl", () => {
  const originalAppUrl = process.env["APP_URL"];

  afterEach(() => {
    if (originalAppUrl === undefined) {
      delete process.env["APP_URL"];
    } else {
      process.env["APP_URL"] = originalAppUrl;
    }
  });

  it("returns APP_URL without trailing slashes", () => {
    process.env["APP_URL"] = "  https://app.example.test//  ";

    expect(getAppUrl()).toBe("https://app.example.test");
  });

  it("returns null when APP_URL is blank", () => {
    process.env["APP_URL"] = "  ";

    expect(getAppUrl()).toBeNull();
  });
});

describe("getBetterAuthCookieDomain", () => {
  const originalCookieDomain = process.env["BETTER_AUTH_COOKIE_DOMAIN"];

  afterEach(() => {
    if (originalCookieDomain === undefined) {
      delete process.env["BETTER_AUTH_COOKIE_DOMAIN"];
    } else {
      process.env["BETTER_AUTH_COOKIE_DOMAIN"] = originalCookieDomain;
    }
  });

  it("returns the trimmed cookie domain", () => {
    process.env["BETTER_AUTH_COOKIE_DOMAIN"] = " scarn.example.test ";

    expect(getBetterAuthCookieDomain()).toBe("scarn.example.test");
  });

  it("returns null when unset", () => {
    delete process.env["BETTER_AUTH_COOKIE_DOMAIN"];

    expect(getBetterAuthCookieDomain()).toBeNull();
  });
});

describe("getEmailPasswordLoginEnabled", () => {
  const original = process.env["ENABLE_EMAIL_PASSWORD_LOGIN"];

  afterEach(() => {
    if (original === undefined) {
      delete process.env["ENABLE_EMAIL_PASSWORD_LOGIN"];
    } else {
      process.env["ENABLE_EMAIL_PASSWORD_LOGIN"] = original;
    }
  });

  it("is on when unset", () => {
    delete process.env["ENABLE_EMAIL_PASSWORD_LOGIN"];

    expect(getEmailPasswordLoginEnabled()).toBe(true);
  });

  it("is off when set to false or 0", () => {
    process.env["ENABLE_EMAIL_PASSWORD_LOGIN"] = " FALSE ";
    expect(getEmailPasswordLoginEnabled()).toBe(false);

    process.env["ENABLE_EMAIL_PASSWORD_LOGIN"] = "0";
    expect(getEmailPasswordLoginEnabled()).toBe(false);
  });

  it("stays on for true", () => {
    process.env["ENABLE_EMAIL_PASSWORD_LOGIN"] = "true";

    expect(getEmailPasswordLoginEnabled()).toBe(true);
  });
});
