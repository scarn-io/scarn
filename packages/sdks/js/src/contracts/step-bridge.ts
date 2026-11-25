/**
 * Work-item routes of the per-run step bridge, shared by the SDK and the
 * worker. A code step's `context.workItems` posts to the same bridge as
 * `context.mcp` (`mcp-bridge.ts`: same base URL and bearer token env vars);
 * the worker forwards each call to the API's code-step work-item routes with
 * the run's claim token, which never enters the container.
 *
 * | Bridge route                      | API route                                         |
 * | --------------------------------- | ------------------------------------------------- |
 * | `POST /work-items/upsert`         | `POST /task-runs/:taskRunId/work-item-upserts`    |
 * | `POST /work-items/create`         | `POST /task-runs/:taskRunId/work-item-creates`    |
 * | `POST /work-items/source-cursor`  | `POST /task-runs/:taskRunId/work-item-source-cursor` |
 *
 * A request body is the API body without `claimToken`; `create` also leaves
 * out `workItemId` and `scope`, which the worker fills in (a fresh UUIDv7 and
 * `"project"`). A 200 body is the API's response unchanged.
 *
 * Other status codes carry `stepBridgeErrorResponseSchema`: 400 for a
 * malformed request, 401 for a missing or wrong bearer token, 413 for a body
 * that is too large, and the API's own 4xx status and `code` relayed as they
 * are (422 `WORK_ITEM_GRANT_MISSING` with `refused`, 403 `PROJECT_FORBIDDEN`,
 * 422 for a validation failure). 502 means the worker couldn't reach the API.
 */
import { z } from "zod";
import { MCP_BRIDGE_TOKEN_ENV, MCP_BRIDGE_URL_ENV } from "./mcp-bridge";

/** The bridge's base URL, as seen from inside the step's container. */
export const STEP_BRIDGE_URL_ENV = MCP_BRIDGE_URL_ENV;
/** The bearer token every bridge request must send. */
export const STEP_BRIDGE_TOKEN_ENV = MCP_BRIDGE_TOKEN_ENV;

export const STEP_BRIDGE_WORK_ITEMS_METHOD = "POST";
export const STEP_BRIDGE_WORK_ITEMS_UPSERT_PATH = "/work-items/upsert";
export const STEP_BRIDGE_WORK_ITEMS_CREATE_PATH = "/work-items/create";
export const STEP_BRIDGE_WORK_ITEMS_SOURCE_CURSOR_PATH =
  "/work-items/source-cursor";

/** At most this many items in one `upsert` call. */
export const MAX_WORK_ITEM_UPSERTS = 100;

/** The platforms a code step may write: the ones a user's sync path writes. */
export const workItemUpsertPlatformValues = [
  "custom",
  "jira",
  "github",
] as const;
export const workItemUpsertPlatformSchema = z.enum(
  workItemUpsertPlatformValues,
);
export type WorkItemUpsertPlatform = z.infer<
  typeof workItemUpsertPlatformSchema
>;

const labelsSchema = z.array(z.string().trim().min(1).max(200)).max(50);
const fieldsSchema = z.record(z.string(), z.unknown());
const platformKeySchema = z.string().trim().min(1).max(500);

/**
 * One imported item, keyed by `(platform, platformKey)`. `sourceUpdatedAt`
 * is required: an item only overwrites a stored one when it is strictly
 * newer. `state` is the source's: `closed` closes the stored item, `open`
 * reopens it. Leaving `labels` out keeps an existing item's labels.
 */
export const workItemUpsertItemSchema = z.object({
  platform: workItemUpsertPlatformSchema,
  platformKey: platformKeySchema,
  platformId: z.string().trim().min(1).nullable().optional(),
  url: z.url().nullable().optional(),
  title: z.string().trim().min(1),
  description: z.string().min(1),
  state: z.enum(["open", "closed"]).optional(),
  sourceCreatedAt: z.iso.datetime({ offset: true }).nullable().optional(),
  sourceUpdatedAt: z.iso.datetime({ offset: true }),
  fields: fieldsSchema.optional(),
  labels: labelsSchema.optional(),
});
export type WorkItemUpsertItem = z.input<typeof workItemUpsertItemSchema>;

export const stepBridgeUpsertRequestSchema = z.object({
  items: z
    .array(workItemUpsertItemSchema)
    .min(1)
    .max(MAX_WORK_ITEM_UPSERTS)
    .superRefine((items, context) => {
      const seen = new Set<string>();
      items.forEach((item, index) => {
        const key = `${item.platform}:${item.platformKey}`;
        if (seen.has(key)) {
          context.addIssue({
            code: "custom",
            message: `platformKey ${item.platformKey} on ${item.platform} appears more than once in this call`,
            path: [index, "platformKey"],
          });
        }
        seen.add(key);
      });
    }),
});
export type StepBridgeUpsertRequest = z.infer<
  typeof stepBridgeUpsertRequestSchema
>;

/** One written item: `created` for a new key, `updated` for newer source data. */
export const upsertedWorkItemSchema = z.object({
  workItemId: z.string(),
  platform: z.string(),
  platformKey: z.string(),
  outcome: z.enum(["created", "updated"]),
});
export type UpsertedWorkItem = z.infer<typeof upsertedWorkItemSchema>;

/** Items written, in input order; items that weren't newer count as `unchanged`. */
export const stepBridgeUpsertResponseSchema = z.object({
  items: z.array(upsertedWorkItemSchema),
  counts: z.object({
    created: z.number().int().nonnegative(),
    updated: z.number().int().nonnegative(),
    unchanged: z.number().int().nonnegative(),
  }),
});
export type StepBridgeUpsertResponse = z.infer<
  typeof stepBridgeUpsertResponseSchema
>;

/**
 * A top-level item in the run's project, on platform `custom`, keyed by
 * `platformKey`. A key the project already has returns that item unchanged.
 */
export const workItemCreateItemSchema = z.object({
  platformKey: platformKeySchema,
  url: z.url().optional(),
  title: z.string().trim().min(1).max(500),
  description: z.string().trim().min(1).max(50_000),
  fields: fieldsSchema.optional(),
  labels: labelsSchema.optional(),
});
export type WorkItemCreateItem = z.input<typeof workItemCreateItemSchema>;

export const stepBridgeCreateRequestSchema = workItemCreateItemSchema;
export type StepBridgeCreateRequest = z.infer<
  typeof stepBridgeCreateRequestSchema
>;

/** `created` is false when the project already had the `platformKey`. */
export const stepBridgeCreateResponseSchema = z.object({
  workItemId: z.string(),
  created: z.boolean(),
});
export type CreatedWorkItem = z.infer<typeof stepBridgeCreateResponseSchema>;

/** Which items a cursor covers: one platform, keys under `keyPrefix` (all when omitted). */
export const workItemSourceSchema = z.object({
  platform: workItemUpsertPlatformSchema,
  keyPrefix: z.string().max(500).optional(),
});
export type WorkItemSource = z.input<typeof workItemSourceSchema>;

export const stepBridgeSourceCursorRequestSchema = workItemSourceSchema;
export type StepBridgeSourceCursorRequest = z.infer<
  typeof stepBridgeSourceCursorRequestSchema
>;

/** The newest `sourceUpdatedAt` under the prefix; null when there is none. */
export const stepBridgeSourceCursorResponseSchema = z.object({
  sourceUpdatedAt: z.string().nullable(),
});
export type StepBridgeSourceCursorResponse = z.infer<
  typeof stepBridgeSourceCursorResponseSchema
>;

/**
 * The body of every non-200 work-item bridge response. `code` is the API's
 * error code when the bridge relays an API error; `meta` its meta.
 */
export const stepBridgeErrorResponseSchema = z.object({
  error: z.string(),
  code: z.string().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});
export type StepBridgeErrorResponse = z.infer<
  typeof stepBridgeErrorResponseSchema
>;
