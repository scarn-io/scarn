import { describe, expect, test } from "bun:test";
import { resolvePublicUrls } from "@scarn/core/lib/public-urls";

describe("resolvePublicUrls", () => {
  test("mounts the API under its own URL when API_URL is set", () => {
    expect(
      resolvePublicUrls({
        appUrl: "https://app.scarn.io",
        apiUrl: "https://api.scarn.io",
      }),
    ).toEqual({
      appUrl: "https://app.scarn.io",
      apiBaseUrl: "https://api.scarn.io/api",
    });
  });

  test("falls back to the app URL when API_URL is unset", () => {
    expect(
      resolvePublicUrls({ appUrl: "https://app.scarn.io", apiUrl: undefined }),
    ).toEqual({
      appUrl: "https://app.scarn.io",
      apiBaseUrl: "https://app.scarn.io/api",
    });
  });

  test("treats a blank API_URL as unset", () => {
    expect(
      resolvePublicUrls({ appUrl: "https://app.scarn.io", apiUrl: "  " }),
    ).toEqual({
      appUrl: "https://app.scarn.io",
      apiBaseUrl: "https://app.scarn.io/api",
    });
  });

  test("drops trailing slashes", () => {
    expect(
      resolvePublicUrls({
        appUrl: "https://app.scarn.io//",
        apiUrl: "https://api.scarn.io/",
      }),
    ).toEqual({
      appUrl: "https://app.scarn.io",
      apiBaseUrl: "https://api.scarn.io/api",
    });
  });

  test("uses API_URL without an app URL", () => {
    expect(
      resolvePublicUrls({ appUrl: null, apiUrl: "https://api.scarn.io" }),
    ).toEqual({ appUrl: null, apiBaseUrl: "https://api.scarn.io/api" });
  });

  test("is null when neither is set", () => {
    expect(resolvePublicUrls({ appUrl: null, apiUrl: undefined })).toEqual({
      appUrl: null,
      apiBaseUrl: null,
    });
  });
});
