import { describe, expect, test } from "bun:test";
import { resolveBrowserScarnApiBaseUrl } from "./scarn-browser-api-client";

describe("resolveBrowserScarnApiBaseUrl", () => {
  test("uses the configured API origin when present", () => {
    expect(
      resolveBrowserScarnApiBaseUrl({
        envApiUrl: "https://api.example.test",
        browserOrigin: "https://app.example.test",
      }),
    ).toBe("https://api.example.test");
  });

  test("strips a trailing /api from the configured API url", () => {
    expect(
      resolveBrowserScarnApiBaseUrl({
        envApiUrl: "https://api.example.test/api/",
      }),
    ).toBe("https://api.example.test");
  });

  test("ignores a relative env API url and falls back to same-origin requests", () => {
    expect(resolveBrowserScarnApiBaseUrl({ envApiUrl: "api" })).toBe("");
  });

  test("falls back to the current browser origin when no API url is set", () => {
    expect(
      resolveBrowserScarnApiBaseUrl({
        envApiUrl: "",
        browserOrigin: "https://preview.example.test",
      }),
    ).toBe("https://preview.example.test");
  });

  test("falls back to a relative base url when nothing is set", () => {
    expect(resolveBrowserScarnApiBaseUrl({ envApiUrl: "" })).toBe("");
  });
});
