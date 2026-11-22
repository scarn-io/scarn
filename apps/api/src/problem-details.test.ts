import { describe, expect, test } from "bun:test";
import {
  CoreError,
  CoreValidationError,
  PersistenceError,
  ResourceNotFoundError,
} from "@scarn/core";
import { managedConnectionNotReady } from "@scarn/core/connections/managed-mcp-connection/application/acquire-managed-access-token";
import {
  InternalServerError,
  InvalidCookie,
  NotFound,
  ParseError,
  status,
  t,
  ValidationError,
} from "elysia";
import { createProblemDetails, getRetryAfterSeconds } from "./problem-details";

const request = new Request("http://localhost/api/work-items/test");

describe("createProblemDetails", () => {
  test("preserves typed client-safe core errors", () => {
    const problem = createProblemDetails({
      error: new CoreValidationError(
        "Work item title is required",
        "WORK_ITEM_TITLE_REQUIRED",
      ),
      request,
    });

    expect(problem.status).toBe(422);
    expect(problem.title).toBe("Work item title is required");
    expect(problem.detail).toBe("Work item title is required");
    expect(problem.code).toBe("WORK_ITEM_TITLE_REQUIRED");
  });

  test("passes a validation error's meta through to the client", () => {
    const markers = [
      { markerIndex: 0, caption: "Recording", reason: "expired" },
    ];
    const problem = createProblemDetails({
      error: new CoreValidationError(
        "Artifacts unavailable",
        "artifact_unavailable",
        { markers },
      ),
      request,
    });

    expect(problem.status).toBe(422);
    expect(problem.code).toBe("artifact_unavailable");
    expect(problem.meta).toEqual({ markers });
  });

  test("omits meta from non-validation errors", () => {
    const problem = createProblemDetails({
      error: new ResourceNotFoundError("Artifact", "abc"),
      request,
    });

    expect(problem.status).toBe(404);
    expect(problem.meta).toBeUndefined();
  });

  test("passes a not-ready managed connection's state and reason through", () => {
    const problem = createProblemDetails({
      error: managedConnectionNotReady("reconnect_required", "refresh_failed"),
      request,
    });

    expect(problem.status).toBe(409);
    expect(problem.code).toBe("MANAGED_CONNECTION_NOT_READY");
    expect(problem.meta).toEqual({
      state: "reconnect_required",
      reasonCode: "refresh_failed",
    });
  });

  test("reads a back-off from meta.retryAfterSeconds without exposing meta", () => {
    const error = new CoreError({
      code: "BUSY",
      message: "Busy",
      status: 503,
      meta: { retryAfterSeconds: 1 },
    });

    expect(getRetryAfterSeconds(error)).toBe(1);
    expect(createProblemDetails({ error, request }).meta).toBeUndefined();
    expect(
      getRetryAfterSeconds(new ResourceNotFoundError("Artifact", "abc")),
    ).toBeUndefined();
  });

  test("hides internal error details when expose is false", () => {
    const problem = createProblemDetails({
      error: new PersistenceError(
        "Failed to save work item abc",
        "WORK_ITEM_SAVE_FAILED",
      ),
      request,
    });

    expect(problem.status).toBe(500);
    expect(problem.title).toBe("Internal Server Error");
    expect(problem.detail).toBe("An unexpected error occurred.");
    expect(problem.code).toBe("WORK_ITEM_SAVE_FAILED");
  });

  test("treats an untyped thrown error as an unknown internal error", () => {
    const problem = createProblemDetails({ error: new Error("boom"), request });

    expect(problem).toMatchObject({
      type: "urn:problem-type:scarn:api:internal-server-error",
      title: "Internal Server Error",
      status: 500,
      detail: "An unexpected error occurred.",
      code: "UNKNOWN",
    });
  });

  test("describes request validation failures with per-field issues", () => {
    const schema = t.Object({ name: t.String() });
    const value = { name: 1 };
    const error = new ValidationError(
      "body",
      value,
      () => [
        { instancePath: "/name", message: "Expected string", keyword: "type" },
      ],
      schema,
    );

    const problem = createProblemDetails({ error, request });

    expect(problem).toMatchObject({
      type: "urn:problem-type:scarn:api:validation",
      title: "Unprocessable Content",
      status: 422,
      detail: "Request validation failed.",
      code: "VALIDATION",
    });
    expect(problem.errors).toEqual([
      { path: "name", message: "Expected string", summary: "Expected string" },
    ]);
  });

  test("maps Elysia's not-found error to NOT_FOUND", () => {
    const problem = createProblemDetails({ error: new NotFound(), request });

    expect(problem).toMatchObject({
      type: "urn:problem-type:scarn:api:not-found",
      title: "Not Found",
      status: 404,
      code: "NOT_FOUND",
    });
  });

  test("maps Elysia's parse error to PARSE", () => {
    const problem = createProblemDetails({ error: new ParseError(), request });

    expect(problem).toMatchObject({
      type: "urn:problem-type:scarn:api:parse",
      title: "Bad Request",
      status: 400,
      detail: "The request body could not be parsed.",
      code: "PARSE",
    });
  });

  test("maps a bad cookie signature to INVALID_COOKIE_SIGNATURE", () => {
    const problem = createProblemDetails({
      error: InvalidCookie.signature("session"),
      request,
    });

    expect(problem).toMatchObject({
      type: "urn:problem-type:scarn:api:invalid-cookie-signature",
      title: "Bad Request",
      status: 400,
      code: "INVALID_COOKIE_SIGNATURE",
    });
  });

  test("maps Elysia's internal server error to INTERNAL_SERVER_ERROR", () => {
    const problem = createProblemDetails({
      error: new InternalServerError("database exploded"),
      request,
    });

    expect(problem).toMatchObject({
      type: "urn:problem-type:scarn:api:internal-server-error",
      title: "Internal Server Error",
      status: 500,
      detail: "An unexpected error occurred.",
      code: "INTERNAL_SERVER_ERROR",
    });
  });

  test("reports a thrown status() by its numeric code", () => {
    const problem = createProblemDetails({
      error: status(409, "Taken"),
      request,
    });

    expect(problem).toMatchObject({
      type: "urn:problem-type:scarn:api:http-409",
      title: "Request Failed",
      status: 409,
      code: "409",
    });
    expect(problem.detail).toBeUndefined();
  });
});
