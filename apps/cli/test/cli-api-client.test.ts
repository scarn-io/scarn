import { describe, expect, test } from "bun:test";
import { describeApiError } from "../src/lib/cli-api-client";

describe("describeApiError", () => {
  test("prefers detail, then title, then a generic fallback", () => {
    expect(describeApiError({ detail: "Nope.", title: "Bad" })).toBe("Nope.");
    expect(describeApiError({ title: "Bad" })).toBe("Bad");
    expect(describeApiError({})).toBe("the server rejected the request");
  });

  test("appends a validation failure's per-field issues", () => {
    expect(
      describeApiError({
        detail: "Request validation failed.",
        errors: [
          {
            path: "code",
            message: "Too big: expected at most 8192 characters",
          },
          { path: "/", message: "Unrecognized key: extra" },
        ],
      }),
    ).toBe(
      "Request validation failed. (code: Too big: expected at most 8192 characters; Unrecognized key: extra)",
    );
  });

  test("an empty errors array adds nothing", () => {
    expect(describeApiError({ detail: "Nope.", errors: [] })).toBe("Nope.");
  });
});
