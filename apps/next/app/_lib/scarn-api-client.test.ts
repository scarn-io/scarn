import { describe, expect, test } from "bun:test";
import { resolveScarnApiBaseUrl } from "./scarn-api-client";

describe("resolveScarnApiBaseUrl", () => {
  test("uses the server API url when present", () => {
    expect(
      resolveScarnApiBaseUrl({
        serverEnvApiUrl: "http://api-internal.example.test",
        publicEnvApiUrl: "https://api.example.test",
        host: "localhost:3001",
      }),
    ).toBe("http://api-internal.example.test");
  });

  test("falls back to the public API url when the server API url is unset", () => {
    expect(
      resolveScarnApiBaseUrl({
        serverEnvApiUrl: "",
        publicEnvApiUrl: "https://api.example.test",
        host: "localhost:3001",
      }),
    ).toBe("https://api.example.test");
  });

  test("uses the current request host in development when no API url is set", () => {
    expect(
      resolveScarnApiBaseUrl({
        publicEnvApiUrl: "",
        host: "localhost:3001",
        protocol: "http",
      }),
    ).toBe("http://localhost:3001");
  });

  test("prefers forwarded host and proto when they are present", () => {
    expect(
      resolveScarnApiBaseUrl({
        publicEnvApiUrl: "",
        host: "localhost:3001",
        forwardedHost: "preview.example.com",
        forwardedProto: "https",
      }),
    ).toBe("https://preview.example.com");
  });
});
