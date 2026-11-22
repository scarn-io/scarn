import { z } from "zod";
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

export const stdErrors = {
  401: apiErrorResponseSchema,
  403: apiErrorResponseSchema,
  422: apiErrorResponseSchema,
  500: apiErrorResponseSchema,
};
