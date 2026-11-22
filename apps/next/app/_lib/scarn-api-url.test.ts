import { describe, expect, test } from "bun:test";
import { normalizeScarnApiOrigin, scarnApiUrl } from "./scarn-api-url";

describe("normalizeScarnApiOrigin", () => {
  test("strips trailing slashes and an /api suffix", () => {
    expect(normalizeScarnApiOrigin(" https://api.example.test/api/ ")).toBe(
      "https://api.example.test",
    );
  });

  test("rejects empty and relative values", () => {
    expect(normalizeScarnApiOrigin("")).toBeUndefined();
    expect(normalizeScarnApiOrigin("api.example.test")).toBeUndefined();
    expect(normalizeScarnApiOrigin(undefined)).toBeUndefined();
  });
});

describe("scarnApiUrl", () => {
  test("is absolute against a configured API origin", () => {
    expect(
      scarnApiUrl("/integrations/github/install", "https://api.example.test"),
    ).toBe("https://api.example.test/api/integrations/github/install");
  });

  test("is same-origin relative without an API origin", () => {
    expect(scarnApiUrl("/auth", undefined)).toBe("/api/auth");
  });
});
