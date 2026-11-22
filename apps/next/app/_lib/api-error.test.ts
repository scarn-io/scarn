import { describe, expect, test } from "bun:test";
import { apiErrorCode, apiErrorMeta, parseApiError } from "./api-error";

const problem = {
  status: 422,
  code: "artifact_unavailable",
  detail: "One or more artifacts are no longer available",
  meta: { markers: [{ markerIndex: 0, caption: "Video", reason: "expired" }] },
};

describe("api-error", () => {
  test("reads problem details from an Eden error wrapper with its own status", () => {
    const edenError = { status: 422, value: problem };

    expect(apiErrorCode(edenError)).toBe("artifact_unavailable");
    expect(apiErrorMeta(edenError)).toEqual(problem.meta);
    expect(parseApiError(edenError, "fallback")).toBe(problem.detail);
  });

  test("reads problem details passed directly", () => {
    expect(apiErrorCode(problem)).toBe("artifact_unavailable");
    expect(apiErrorMeta(problem)).toEqual(problem.meta);
  });

  test("falls back when the error isn't problem details", () => {
    expect(apiErrorCode({ status: 500, value: "boom" })).toBeUndefined();
    expect(
      apiErrorMeta({ status: 400, value: { status: 400 } }),
    ).toBeUndefined();
    expect(parseApiError(new Error("network"), "fallback")).toBe("fallback");
  });
});
