import { z } from "zod";
import { uuidV7Schema } from "@scarn/core/common/contracts/uuid-v7";
import {
  grantSchema,
  grantsSchema,
} from "@scarn/core/tasks/task/domain/grants";
import {
  grantRequestStatusValues,
  type GrantRequest,
} from "../domain/grant-request";

export const grantRequestIdParamsSchema = z.object({
  grantRequestId: uuidV7Schema,
});

/**
 * A person's decision on a pending grant request: the grants they approve,
 * each covered by a requested one (labels may be a subset), `[]` to deny,
 * and an optional note for the agent.
 */
export const decideGrantRequestBodySchema = z.strictObject({
  approved: grantsSchema.max(20),
  note: z.string().trim().max(2000).optional(),
});

export const decideGrantRequestInputSchema = grantRequestIdParamsSchema.extend(
  decideGrantRequestBodySchema.shape,
);

export type DecideGrantRequestInput = z.input<
  typeof decideGrantRequestInputSchema
>;

export const grantRequestSchema = z.object({
  id: uuidV7Schema,
  taskId: uuidV7Schema,
  /** The run that handed over with the request. */
  taskRunId: uuidV7Schema,
  reason: z.string(),
  requested: z.array(grantSchema),
  status: z.enum(grantRequestStatusValues),
  /** Null until decided; `[]` is a deny. */
  approved: z.array(grantSchema).nullable(),
  note: z.string().nullable(),
  decidedByUserId: uuidV7Schema.nullable(),
  decidedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});

export type GrantRequestContract = z.infer<typeof grantRequestSchema>;

export const grantRequestListSchema = z.array(grantRequestSchema);

export const grantRequestToContract = (
  request: GrantRequest,
): GrantRequestContract => ({
  id: request.id,
  taskId: request.taskId,
  taskRunId: request.taskRunId,
  reason: request.reason,
  requested: request.requested,
  status: request.status,
  approved: request.approved,
  note: request.note,
  decidedByUserId: request.decidedByUserId,
  decidedAt: request.decidedAt?.toISOString() ?? null,
  createdAt: request.createdAt.toISOString(),
});
