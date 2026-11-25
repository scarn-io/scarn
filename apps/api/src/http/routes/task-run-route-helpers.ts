import { ParseError } from "elysia";
import { z } from "zod";
import { CoreError } from "@scarn/core/lib/errors";
import { apiErrorResponseSchema } from "../../contracts";
import {
  getTaskRunInputSchema,
  listTaskRunsByProjectIdInputSchema,
} from "@scarn/core/tasks/task-run/contracts/task-run-contracts";

export const taskRunIdParamsSchema = z.object({
  taskRunId: getTaskRunInputSchema,
});

export const listTaskRunsQuerySchema = z.object({
  projectId: listTaskRunsByProjectIdInputSchema,
});

const bodyTooLarge = (maxBytes: number) =>
  new CoreError({
    code: "PAYLOAD_TOO_LARGE",
    message: `The request body is larger than ${String(maxBytes)} bytes`,
    status: 413,
  });

/**
 * A route `parse` hook that reads a JSON body of at most `maxBytes`, refusing
 * a larger one with 413 before parsing it. Elysia wraps what the hook throws
 * in a `ParseError`; the problem mapper reports the `CoreError` inside.
 *
 * List it before `"json"` (`parse: [jsonBodyOfAtMost(n), "json"]`): the hook
 * always yields the body, so the named parser never runs, but it is what
 * makes the OpenAPI document publish the route's JSON body schema.
 */
export const jsonBodyOfAtMost =
  (maxBytes: number) =>
  async ({ request }: { request: Request }): Promise<unknown> => {
    const declared = Number(request.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw bodyTooLarge(maxBytes);
    }
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength > maxBytes) {
      throw bodyTooLarge(maxBytes);
    }
    try {
      return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    } catch (error) {
      throw new ParseError(error instanceof Error ? error : undefined);
    }
  };

export const stdErrors = {
  401: apiErrorResponseSchema,
  403: apiErrorResponseSchema,
  422: apiErrorResponseSchema,
  500: apiErrorResponseSchema,
};
