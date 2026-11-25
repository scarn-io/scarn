import { describe, expect, test } from "bun:test";
import {
  CLI_USER_AGENT,
  createCliLabeledFetch,
  describeApiError,
} from "../src/lib/cli-api-client";

describe("createCliLabeledFetch", () => {
  test("labels every request as the CLI and keeps the caller's headers", async () => {
    const sent: Request[] = [];
    const labeledFetch = createCliLabeledFetch(async (input) => {
      sent.push(input as Request);
      return new Response(null, { status: 204 });
    });

    await labeledFetch("https://api.example.test/api/things", {
      headers: { authorization: "Bearer t" },
    });

    const headers = sent[0]?.headers;
    expect(headers?.get("x-scarn-client")).toBe("cli");
    expect(headers?.get("x-scarn-client-version")).toEqual(expect.any(String));
    expect(headers?.get("user-agent")).toBe(CLI_USER_AGENT);
    expect(headers?.get("authorization")).toBe("Bearer t");
  });
});

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
