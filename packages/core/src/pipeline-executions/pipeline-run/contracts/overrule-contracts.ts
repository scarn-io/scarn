import { uuidV7Schema } from "@scarn/core/common/contracts/uuid-v7";
import { z } from "zod";
import {
  nodeVisitStatusValues,
  visitTransitionSchema,
} from "./pipeline-run-contracts";

/** Names one route of the visit's node: by position, `otherwise`, target node id or label. */
export const routeSelectorSchema = z.union([
  z.object({ kind: z.literal("route"), index: z.int().nonnegative() }),
  z.object({ kind: z.literal("otherwise") }),
  z.object({ to: z.string().min(1) }),
  z.object({ label: z.string().min(1) }),
]);

export const overruleVisitRouteBodySchema = z.object({
  /** The full set of routes to take. One for a `match: "first"` node. */
  routes: z.array(routeSelectorSchema),
  reason: z.string().trim().min(1).max(2000),
  acceptMissing: z.boolean().default(false),
  preview: z.boolean().default(false),
});

export const overruleVisitRouteInputSchema =
  overruleVisitRouteBodySchema.extend({
    pipelineExecutionId: uuidV7Schema,
    visitId: uuidV7Schema,
  });

export const missingArgSchema = z.object({
  arg: z.string(),
  reference: z.string(),
});

const previewLaneSchema = z.object({
  route: visitTransitionSchema,
  label: z.string().optional(),
});

/** What an overrule would do, without doing it. */
export const overrulePreviewSchema = z.object({
  superseded: z.array(
    z.object({
      visitId: uuidV7Schema,
      nodeId: z.string(),
      status: z.enum(nodeVisitStatusValues),
    }),
  ),
  cancelledTasks: z.number().int().nonnegative(),
  lanesAdded: z.array(previewLaneSchema),
  lanesRemoved: z.array(previewLaneSchema),
  /** Merge node ids that will fire again. */
  mergesRerun: z.array(z.string()),
  /** Node ids entered straight away. */
  started: z.array(z.string()),
  reopensRun: z.boolean(),
  missing: z.array(missingArgSchema),
});

export const overrulePreviewResultSchema = z.object({
  preview: overrulePreviewSchema,
});

export type RouteSelector = z.infer<typeof routeSelectorSchema>;
export type OverruleVisitRouteInput = z.input<
  typeof overruleVisitRouteInputSchema
>;
export type OverrulePreviewResult = z.infer<typeof overrulePreviewResultSchema>;
