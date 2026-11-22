import { describe, expect, test } from "bun:test";
import { createAppContext } from "@scarn/core/lib/di";
import { appOrigin, appRedirectUrl } from "./app-redirect";

const request = new Request("https://api.scarn.io/integrations/callback?x=1");

describe("appRedirectUrl", () => {
  test.concurrent("targets the app URL when it differs from the API's", () => {
    const appContext = createAppContext({ appUrl: "https://app.scarn.io/" });

    expect(appOrigin(appContext, request)).toBe("https://app.scarn.io");
    expect(
      appRedirectUrl(appContext, request, "/acme/proj/settings", {
        connection: "c1",
      }).toString(),
    ).toBe("https://app.scarn.io/acme/proj/settings?connection=c1");
  });

  test.concurrent(
    "falls back to the request's origin without an app URL",
    () => {
      const appContext = createAppContext({ appUrl: null });

      expect(appOrigin(appContext, request)).toBe("https://api.scarn.io");
      expect(appRedirectUrl(appContext, request, "/login").toString()).toBe(
        "https://api.scarn.io/login",
      );
    },
  );

  test.concurrent("keeps a path's own query and appends params", () => {
    const appContext = createAppContext({ appUrl: "https://app.scarn.io" });

    expect(
      appRedirectUrl(appContext, request, "/projects/new?source=cli", {
        installation: "connected",
      }).toString(),
    ).toBe(
      "https://app.scarn.io/projects/new?source=cli&installation=connected",
    );
  });
});
