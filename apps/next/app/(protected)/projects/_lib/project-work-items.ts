import {
  WORK_ITEM_FIELD_FILTER_PREFIX,
  type AutomationListItemContract,
  type PipelineRunStatus,
  type WorkItemAgentFilter,
  type WorkItemContract,
  type WorkItemListItemContract,
  type PaginatedWorkItemsContract,
  type WorkItemFieldOptionContract,
  type PipelineDefinitionContract,
  type StepDefinitionContract,
  parseUuidV7,
} from "@scarn/api/frontend-contracts";
import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";

export type WorkItemFieldFilter = {
  key: string;
  value: string;
};

export type ProjectWorkItemsQuery = {
  q?: string;
  page: number;
  pageSize: number;
  /**
   * The URL's own `sort` token (`created-desc`, `score:<id>:<step>:<signal>:asc`,
   * etc.) — forwarded verbatim to the route's `sort` query param, which parses
   * it through the identical grammar (`parseWorkItemSortToken`). See
   * `project-work-items-params.ts`'s `parseWorkItemSort`/`formatWorkItemSort`
   * for the structured shape this token round-trips through in the UI.
   */
  sort?: string;
  fieldFilters?: WorkItemFieldFilter[];
  /** Items carrying every one of these labels; sent comma-joined. */
  labels?: string[];
  /**
   * Half-open bounds on the item's effective last-updated instant, in the
   * URL's own grammar (`24h`, `7d`, `2026-01-14`). Sent unresolved: a relative
   * bound is measured against the server's clock, so "the last 7 days" keeps
   * meaning that however long the tab has been open.
   */
  updatedAfter?: string;
  updatedBefore?: string;
  /**
   * Only items with a pending or failed agent-drafted comment awaiting a
   * human decision. Sent as the literal string `"true"` or omitted — there is
   * no `"false"` on the wire, matching the filter model's strict parse.
   */
  awaitingApproval?: boolean;
  /** `me`, `none`, or a member's user id. */
  assignee?: string;
  agent?: WorkItemAgentFilter;
  /** The latest pipeline run's stored status. */
  status?: PipelineRunStatus;
  platform?: WorkItemContract["platform"];
};

/** A work item as returned by the paginated listing endpoint. */
export type WorkItemListItem = WorkItemListItemContract;

/** The `{ items, pagination }` envelope returned by the listing endpoint. */
export type PaginatedWorkItems = PaginatedWorkItemsContract;

/**
 * An option a user can filter on for a single dynamic `fields` key. Sourced from
 * `GET /projects/:projectId/work-item-field-options`, which caps the number of
 * distinct values per key — `truncated` is `true` when values were dropped, so
 * the list should not be treated as exhaustive.
 */
export type WorkItemFieldFilterOption = WorkItemFieldOptionContract;

// ─── Query params ────────────────────────────────────────────────────────────

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

/**
 * `page`/`pageSize` are validated at the route boundary, so an out-of-range or
 * non-integer value (e.g. a `?page=abc` URL yielding `NaN`) would surface as a
 * 422 rather than a page of results. Fall back to the defaults instead.
 */
const sanitizePage = (page: number): number =>
  Number.isInteger(page) && page >= 1 ? page : DEFAULT_PAGE;

const sanitizePageSize = (pageSize: number): number =>
  Number.isInteger(pageSize) && pageSize >= 1 && pageSize <= MAX_PAGE_SIZE
    ? pageSize
    : DEFAULT_PAGE_SIZE;

const buildFieldFilterParams = (
  fieldFilters: WorkItemFieldFilter[] | undefined,
): Record<string, string> => {
  const params: Record<string, string> = {};
  for (const filter of fieldFilters ?? []) {
    // A blank key or value is dropped server-side anyway; skip it here so the
    // request stays minimal and the params are unambiguous.
    if (filter.key.length === 0 || filter.value.length === 0) continue;
    params[
      `${WORK_ITEM_FIELD_FILTER_PREFIX}${encodeURIComponent(filter.key)}`
    ] = filter.value;
  }
  return params;
};

/**
 * Flatten the structured query into the route's flat query params. Field-filter
 * params are spread first so a (theoretically impossible) collision with a
 * declared param can never shadow it.
 */
const buildProjectWorkItemsQueryParams = (query: ProjectWorkItemsQuery) => {
  const search = query.q?.trim();
  return {
    ...buildFieldFilterParams(query.fieldFilters),
    // `?q=` is accepted by the route but means nothing; omit it when blank.
    ...(search !== undefined && search.length > 0 ? { q: search } : {}),
    ...(query.labels && query.labels.length > 0
      ? { labels: query.labels.join(",") }
      : {}),
    ...(query.updatedAfter ? { updatedAfter: query.updatedAfter } : {}),
    ...(query.updatedBefore ? { updatedBefore: query.updatedBefore } : {}),
    ...(query.awaitingApproval ? { awaitingApproval: "true" } : {}),
    ...(query.assignee ? { assignee: query.assignee } : {}),
    ...(query.agent ? { agent: query.agent } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.platform ? { platform: query.platform } : {}),
    page: sanitizePage(query.page),
    pageSize: sanitizePageSize(query.pageSize),
    ...(query.sort ? { sort: query.sort } : {}),
  };
};

// ─── Browser (client-side) fetch functions ───────────────────────────────────

export async function fetchProject(projectId: string) {
  const apiClient = getBrowserScarnApiClient();
  const { data, error } = await apiClient.api.projects({ projectId }).get();
  if (error) throw new Error("Project not found");
  return data;
}

export async function fetchWorkItem(
  workItemId: string,
): Promise<WorkItemContract> {
  const apiClient = getBrowserScarnApiClient();
  const { data, error } = await apiClient.api["work-items"]({
    workItemId,
  }).get();
  if (error) throw new Error("Work item not found");
  return data;
}

/**
 * Fetch one page of work items. Search, field filtering, signal-score sorting,
 * and pagination all happen server-side; `pagination.page` echoes the requested
 * page, so an out-of-range page yields empty `items` with the real `total`.
 */
export async function fetchProjectWorkItems(
  projectId: string,
  query: ProjectWorkItemsQuery,
): Promise<PaginatedWorkItems> {
  const apiClient = getBrowserScarnApiClient();
  const { data, error } = await apiClient.api
    .projects({ projectId })
    ["work-items"].get({ query: buildProjectWorkItemsQueryParams(query) });
  if (error) throw new Error("Failed to load work items");
  return data;
}

/**
 * Fetch the filterable `fields` keys and their distinct scalar values for a
 * project. Independent of the active filters and of the current page, so the
 * dropdowns stay stable as the user filters.
 */
export async function fetchWorkItemFieldOptions(
  projectId: string,
): Promise<WorkItemFieldFilterOption[]> {
  const apiClient = getBrowserScarnApiClient();
  const { data, error } = await apiClient.api
    .projects({ projectId })
    ["work-item-field-options"].get();
  if (error) throw new Error("Failed to load work item field options");
  return data;
}

/** The project's distinct work item labels, sorted, for suggestions. */
export async function fetchWorkItemLabels(
  projectId: string,
): Promise<string[]> {
  const apiClient = getBrowserScarnApiClient();
  const { data, error } = await apiClient.api
    .projects({ projectId })
    ["work-item-labels"].get();
  if (error) throw new Error("Failed to load work item labels");
  return data;
}

export async function fetchProjectPipelineDefinitions(
  projectId: string,
): Promise<PipelineDefinitionContract[]> {
  const apiClient = getBrowserScarnApiClient();
  const { data } = await apiClient.api
    .projects({ projectId })
    ["pipeline-definitions"].get();
  if (!Array.isArray(data)) return [];
  return data;
}

/** The project's automations with their schedule summaries, in key order. */
export async function fetchProjectAutomations(
  projectId: string,
): Promise<AutomationListItemContract[]> {
  const apiClient = getBrowserScarnApiClient();
  const { data, error } = await apiClient.api
    .projects({ projectId })
    .automations.get();
  if (error) throw new Error("Failed to load automations");
  return data;
}

/** Whether the project has a project automation that's switched on. */
export async function fetchHasEnabledProjectAutomation(
  projectId: string,
): Promise<boolean> {
  const automations = await fetchProjectAutomations(projectId);
  return automations.some(
    (automation) => automation.scope === "project" && automation.enabled,
  );
}

/** The project's step definitions; their result schemas feed the score sort. */
export async function fetchProjectStepDefinitions(
  projectId: string,
): Promise<StepDefinitionContract[]> {
  const apiClient = getBrowserScarnApiClient();
  const { data } = await apiClient.api["step-definitions"].get({
    query: { projectId: parseUuidV7(projectId) },
  });
  if (!Array.isArray(data)) return [];
  return data;
}

// ─── Shared (isomorphic) helpers ─────────────────────────────────────────────

/**
 * Insert `item` at the first position whose sort key sorts after it, appending
 * when none does. A linear scan rather than a binary search: the caller's list
 * is sorted by Postgres, whose collation need not agree with `localeCompare`,
 * and these lists are small (capped per key).
 */
const insertAtSortedIndex = <T>(
  items: T[],
  item: T,
  sortKeyOf: (candidate: T) => string,
): T[] => {
  const sortKey = sortKeyOf(item);
  const index = items.findIndex(
    (candidate) => sortKeyOf(candidate).localeCompare(sortKey) > 0,
  );
  return index === -1
    ? [...items, item]
    : [...items.slice(0, index), item, ...items.slice(index)];
};

const identity = (value: string) => value;

/**
 * Union the active filters' values into the fetched field options.
 *
 * The options endpoint caps the values it returns per key, and caps the number
 * of keys, so a value the user is currently filtering on can legitimately be
 * missing from the list. `WorkItemFieldFilters` falls back to `""` for a value
 * that isn't in its key's options, which would blank the dropdown while the
 * filter is still applied. Merging the active values back in prevents that.
 *
 * Pure: neither argument (nor any nested array) is mutated. Returns `options`
 * itself when nothing needs adding, so callers can memoize on identity.
 */
export function mergeActiveFieldFilterValues(
  options: WorkItemFieldFilterOption[],
  activeFilters: WorkItemFieldFilter[],
): WorkItemFieldFilterOption[] {
  let merged = options;

  for (const filter of activeFilters) {
    if (filter.key.length === 0 || filter.value.length === 0) continue;

    const index = merged.findIndex((option) => option.key === filter.key);
    const option = index === -1 ? undefined : merged[index];

    if (option === undefined) {
      // The key isn't offered at all — it was capped out, or every work item
      // carrying it fell outside the scalar-value filter. `truncated` is true
      // because this synthesized list is known to be incomplete.
      merged = insertAtSortedIndex(
        merged,
        { key: filter.key, values: [filter.value], truncated: true },
        (candidate) => candidate.key,
      );
      continue;
    }

    if (option.values.includes(filter.value)) continue;

    const values = insertAtSortedIndex(option.values, filter.value, identity);
    merged = [
      ...merged.slice(0, index),
      { ...option, values },
      ...merged.slice(index + 1),
    ];
  }

  return merged;
}
