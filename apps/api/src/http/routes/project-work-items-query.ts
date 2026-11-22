import { z } from "zod";
import {
  MAX_WORK_ITEMS_PAGE_SIZE,
  timeBoundSchema,
  WORK_ITEM_FIELD_FILTER_PREFIX,
  workItemAgentFilterSchema,
  workItemAssigneeFilterSchema,
  workItemLatestExecutionStatusFilterSchema,
  workItemPlatformSchema,
  type ListWorkItemsQueryInput,
  type WorkItemFieldFilter,
  type WorkItemTimeBound,
} from "@scarn/core/work-items/work-item/contracts/work-item-contracts";
import { parseWorkItemSortToken } from "@scarn/core/work-items/work-item/contracts/work-item-sort-token";

/**
 * Flat HTTP query params for `GET /projects/:projectId/work-items`.
 *
 * Two deliberate shape choices:
 *
 * 1. **Loose object.** The `f.<encodedKey>=<value>` filter params are dynamic,
 *    so they must survive validation rather than be stripped or rejected.
 * 2. **No `.default()`.** Elysia types the Eden client's `query` from the
 *    schema's *output*, so a defaulted key is a required key there. Leaving
 *    `page`/`pageSize` optional keeps `query` itself optional for callers; the
 *    defaults are applied by `listWorkItemsQuerySchema` in the use case.
 *
 * Everything declared here is validated strictly, which is what makes bad
 * `page`/`pageSize` values fail at the route boundary as a 422 instead of
 * throwing a `ZodError` out of the use case (which the error handler can only
 * classify as a 500).
 */
export const listProjectWorkItemsQuerySchema = z.looseObject({
  // Lenient on purpose: clearing the search box yields `?q=`, which should mean
  // "no search", not a validation failure. Normalized away below.
  q: z.string().optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_WORK_ITEMS_PAGE_SIZE)
    .optional(),
  // Lenient for the same reason as `q`: a hand-edited or stale URL carrying a
  // bound this grammar no longer understands should drop that clause, not blank
  // the page with a 422. Validated by `timeBoundSchema` below instead.
  updatedAfter: z.string().optional(),
  updatedBefore: z.string().optional(),
  // Strictly `"true"` (mirrors the browser's total-parser rule); anything
  // else is dropped by `toListWorkItemsQuery` below rather than rejected,
  // same tolerance as the other filter params here. Server-side gated behind
  // `comments:read` inside `listWorkItemsByProject` — this route never
  // checks the permission itself.
  awaitingApproval: z.string().optional(),
  // `me`, `none` or a user id. Lenient: an unreadable value drops the clause.
  assignee: z.string().optional(),
  // `waiting_on_me` | `running` | `queued` | `waiting_on_blockers` | `failed`. Lenient.
  agent: z.string().optional(),
  // The latest pipeline run's stored status (`active`, `waiting`,
  // `succeeded`, `failed`, `cancelled`). Lenient.
  status: z.string().optional(),
  // A work item platform (`github`, `jira`, ...). Lenient.
  platform: z.string().optional(),
  // Comma-separated; an item must carry every label. Blank entries drop.
  // Elysia splits a comma list into an array before validation, so both
  // shapes arrive here.
  labels: z.union([z.string(), z.array(z.string())]).optional(),
  // Lenient for the same reason as `q`/`updatedAfter`: an unrecognized or
  // malformed token (a stale URL, a hand-edited one) should drop the sort
  // silently rather than 422 the whole request — see
  // `parseWorkItemSortToken`, which never throws.
  sort: z.string().optional(),
});

export type ListProjectWorkItemsQueryParams = z.infer<
  typeof listProjectWorkItemsQuerySchema
>;

/**
 * Collect the `f.`-prefixed params into field filters. Mirrors the browser-side
 * parser: a blank key or blank value is skipped, and a key that is not valid
 * percent-encoding is skipped rather than failing the whole request.
 */
const parseFieldFilters = (
  query: ListProjectWorkItemsQueryParams,
): WorkItemFieldFilter[] => {
  const filters: WorkItemFieldFilter[] = [];
  for (const [param, value] of Object.entries(query)) {
    if (!param.startsWith(WORK_ITEM_FIELD_FILTER_PREFIX)) continue;
    if (typeof value !== "string" || value.length === 0) continue;
    const encodedKey = param.slice(WORK_ITEM_FIELD_FILTER_PREFIX.length);
    if (encodedKey.length === 0) continue;
    let key: string;
    try {
      key = decodeURIComponent(encodedKey);
    } catch {
      continue;
    }
    filters.push({ key, value });
  }
  return filters;
};

/**
 * Keep a bound only if it parses. Dropping an unreadable bound rather than
 * rejecting the request means one bad param costs its own clause and nothing
 * else — the same tolerance the field filters and `sort` already get.
 */
const parseTimeBound = (
  raw: string | undefined,
): WorkItemTimeBound | undefined => {
  if (raw === undefined) return undefined;
  const result = timeBoundSchema.safeParse(raw);
  return result.success ? result.data : undefined;
};

const parseLabels = (raw: string | string[] | undefined): string[] =>
  [raw ?? []]
    .flat()
    .flatMap((part) => part.split(","))
    .map((label) => label.trim())
    .filter((label) => label.length > 0);

/** Keep `raw` only if `schema` accepts it, the same tolerance as the bounds. */
const parseLenient = <T>(
  schema: z.ZodType<T>,
  raw: string | undefined,
): T | undefined => {
  if (raw === undefined) return undefined;
  const result = schema.safeParse(raw.trim());
  return result.success ? result.data : undefined;
};

/**
 * Map the flat params onto the structured contract query. `sort` is parsed
 * through the same token grammar the browser writes it with
 * (`parseWorkItemSortToken`); an unrecognized token drops the sort rather
 * than rejecting the request.
 */
export const toListWorkItemsQuery = (
  query: ListProjectWorkItemsQueryParams,
): ListWorkItemsQueryInput => {
  const search = query.q?.trim();

  return {
    q: search !== undefined && search.length > 0 ? search : undefined,
    fieldFilters: parseFieldFilters(query),
    labels: parseLabels(query.labels),
    updatedAfter: parseTimeBound(query.updatedAfter),
    updatedBefore: parseTimeBound(query.updatedBefore),
    awaitingApproval: query.awaitingApproval,
    assignee: parseLenient(workItemAssigneeFilterSchema, query.assignee),
    agent: parseLenient(workItemAgentFilterSchema, query.agent),
    latestExecutionStatus: parseLenient(
      workItemLatestExecutionStatusFilterSchema,
      query.status,
    ),
    platform: parseLenient(workItemPlatformSchema, query.platform),
    sort: parseWorkItemSortToken(query.sort),
    page: query.page,
    pageSize: query.pageSize,
  };
};
