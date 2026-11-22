import { describe, expect, test } from "bun:test";
import {
  GITHUB_TOKEN_MAX_EXPIRY_DAYS,
  githubTokenExpiryDate,
  githubTokenUrl,
} from "./github-token-url";

describe("githubTokenUrl", () => {
  test("pre-fills the fine-grained token form with Issues write and the longest expiry", () => {
    const url = new URL(githubTokenUrl());

    expect(`${url.origin}${url.pathname}`).toBe(
      "https://github.com/settings/personal-access-tokens/new",
    );
    expect(url.searchParams.get("issues")).toBe("write");
    expect(url.searchParams.get("expires_in")).toBe(
      String(GITHUB_TOKEN_MAX_EXPIRY_DAYS),
    );
    expect(url.searchParams.get("name")).toBe("Scarn");
    expect(url.searchParams.has("target_name")).toBe(false);
  });

  test("sets the resource owner when one is given", () => {
    const url = new URL(githubTokenUrl({ owner: "acme" }));

    expect(url.searchParams.get("target_name")).toBe("acme");
  });
});

describe("githubTokenExpiryDate", () => {
  test("is the longest GitHub expiry from the given day", () => {
    expect(githubTokenExpiryDate(new Date(2026, 9, 20))).toBe("2027-10-21");
  });
});
