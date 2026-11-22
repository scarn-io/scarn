import { describe, expect, test } from "bun:test";
import {
  GITHUB_RATE_LIMIT_MIN_REMAINING,
  createGitHubRateLimitSignal,
  isGitHubRateLimitLow,
  isGitHubRateLimitResponse,
  readGitHubRateLimitStatus,
} from "@/integrations/github-ingest/infra/github-rate-limit";

const responseWithHeaders = (headers: Record<string, string>): Response =>
  new Response(null, { status: 200, headers });

describe("readGitHubRateLimitStatus", () => {
  test("parses X-RateLimit-Remaining and Retry-After when present", () => {
    const status = readGitHubRateLimitStatus(
      responseWithHeaders({
        "x-ratelimit-remaining": "42",
        "retry-after": "30",
      }),
    );
    expect(status).toEqual({ remaining: 42, retryAfterSeconds: 30 });
  });

  test("returns nulls when headers are absent", () => {
    const status = readGitHubRateLimitStatus(responseWithHeaders({}));
    expect(status).toEqual({ remaining: null, retryAfterSeconds: null });
  });

  test("returns null for an unparseable header value", () => {
    const status = readGitHubRateLimitStatus(
      responseWithHeaders({ "x-ratelimit-remaining": "not-a-number" }),
    );
    expect(status.remaining).toBeNull();
  });
});

describe("isGitHubRateLimitLow", () => {
  test("is false when remaining is at or above the threshold and no Retry-After", () => {
    expect(
      isGitHubRateLimitLow({
        remaining: GITHUB_RATE_LIMIT_MIN_REMAINING,
        retryAfterSeconds: null,
      }),
    ).toBe(false);
  });

  test("is true when remaining drops below the absolute threshold", () => {
    expect(
      isGitHubRateLimitLow({
        remaining: GITHUB_RATE_LIMIT_MIN_REMAINING - 1,
        retryAfterSeconds: null,
      }),
    ).toBe(true);
  });

  test("is true whenever Retry-After is present, regardless of remaining", () => {
    expect(
      isGitHubRateLimitLow({ remaining: 5000, retryAfterSeconds: 60 }),
    ).toBe(true);
  });
});

describe("createGitHubRateLimitSignal", () => {
  test("starts non-exhausted and flips to exhausted on a low-remaining response", () => {
    const signal = createGitHubRateLimitSignal();
    expect(signal.isExhausted).toBe(false);

    signal.recordResponse(
      responseWithHeaders({
        "x-ratelimit-remaining": String(GITHUB_RATE_LIMIT_MIN_REMAINING - 1),
      }),
    );

    expect(signal.isExhausted).toBe(true);
  });

  test("stays non-exhausted for a healthy-remaining response", () => {
    const signal = createGitHubRateLimitSignal();
    signal.recordResponse(
      responseWithHeaders({ "x-ratelimit-remaining": "4999" }),
    );
    expect(signal.isExhausted).toBe(false);
  });

  test("is sticky — once exhausted, a later healthy response doesn't un-trip it", () => {
    const signal = createGitHubRateLimitSignal();
    signal.recordResponse(
      responseWithHeaders({ "x-ratelimit-remaining": "1" }),
    );
    expect(signal.isExhausted).toBe(true);

    signal.recordResponse(
      responseWithHeaders({ "x-ratelimit-remaining": "4999" }),
    );
    expect(signal.isExhausted).toBe(true);
  });
});

describe("isGitHubRateLimitResponse", () => {
  const failed = (status: number, headers: Record<string, string> = {}) =>
    new Response(null, { status, headers });

  test.each([
    ["403 with Retry-After", failed(403, { "retry-after": "60" }), true],
    ["429 with Retry-After", failed(429, { "retry-after": "60" }), true],
    [
      "403 with no remaining budget",
      failed(403, { "x-ratelimit-remaining": "0" }),
      true,
    ],
    ["plain 403", failed(403), false],
    ["404", failed(404, { "retry-after": "60" }), false],
    [
      "SSO 403",
      failed(403, { "x-github-sso": "required; url=https://github.com/sso" }),
      false,
    ],
    [
      "403 with budget left",
      failed(403, { "x-ratelimit-remaining": "12" }),
      false,
    ],
  ])("%s → %p", (_label, response, expected) => {
    expect(isGitHubRateLimitResponse(response)).toBe(expected);
  });
});
