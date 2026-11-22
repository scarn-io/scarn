import { z } from "zod";
import { uuidV7Schema } from "@scarn/core/common/contracts/uuid-v7";
import {
  pipelineExecutionDisplayStatusValues,
  pipelineExecutionSortValues,
  MAX_PIPELINE_EXECUTIONS_PAGE_SIZE,
  type ListPipelineExecutionsQueryInput,
} from "@scarn/core/pipeline-executions/pipeline-run/contracts/pipeline-run-contracts";

/**
 * Flat HTTP query params for `GET /pipeline-executions`.
 *
 * Follows `project-work-items-query.ts`, including its one non-obvious choice:
 * **no `.default()`**. Elysia types the Eden client's `query` from the schema's
 * *output*, so a defaulted key becomes a required key for every caller. Leaving
 * `page`/`pageSize`/`sort` optional here keeps them optional at the call site;
 * the defaults live in `listPipelineExecutionsQuerySchema`, applied in the
 * use case.
 *
 * Unlike the work items query this is a strict object — there are no dynamic
 * params to preserve — so a bad `page`, `pageSize`, `status`, or `sort` fails at
 * the route boundary as a 422 rather than throwing a `ZodError` out of the use
 * case (which the error handler could only classify as a 500).
 */
export const listPipelineExecutionsRouteQuerySchema = z.object({
  projectId: uuidV7Schema,
  pipelineId: uuidV7Schema.optional(),
  workItemId: uuidV7Schema.optional(),
  status: z.enum(pipelineExecutionDisplayStatusValues).optional(),
  sort: z.enum(pipelineExecutionSortValues).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PIPELINE_EXECUTIONS_PAGE_SIZE)
    .optional(),
});

export type ListPipelineExecutionsRouteQueryParams = z.infer<
  typeof listPipelineExecutionsRouteQuerySchema
>;

/**
 * The route params and the contract query happen to share a shape, so this is a
 * pass-through today. It exists anyway as the single seam where the two can
 * diverge — the work-items precedent needed exactly that once `f.` filters and
 * the sort triple arrived.
 */
export const toListPipelineExecutionsQuery = (
  query: ListPipelineExecutionsRouteQueryParams,
): ListPipelineExecutionsQueryInput => ({
  projectId: query.projectId,
  pipelineId: query.pipelineId,
  workItemId: query.workItemId,
  status: query.status,
  sort: query.sort,
  page: query.page,
  pageSize: query.pageSize,
});
