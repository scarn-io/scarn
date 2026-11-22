import {
  projectRunStartedByFilterSchema,
  projectRunStatusFilterSchema,
  projectRunWhatRanFilterSchema,
  MAX_PROJECT_RUNS_SEARCH_LENGTH,
  type ProjectRunStartedByFilter,
  type ProjectRunStatusFilter,
  type ProjectRunWhatRanFilter,
} from "@scarn/core/pipeline-executions/project-runs/contracts/project-runs-contracts";
import { uuidV7Schema } from "@scarn/core/common/contracts/uuid-v7";

/**
 * The Runs list's state, held in the URL so every view is linkable and Back
 * works: `?status&whatRan&by&item&at&q`. A junk value falls back to its
 * default rather than turning into a 422.
 */
export type RunsNav = {
  /** A status tab or a single status; `open` (In progress) when absent. */
  status: ProjectRunStatusFilter;
  whatRan?: ProjectRunWhatRanFilter;
  /** `startedBy`: an automation id, or `me`. */
  by?: ProjectRunStartedByFilter;
  /** `workItemId`: the work item or any of its children. */
  item?: string;
  /** `atNode`: only meaningful with a pipeline `whatRan`. */
  at?: string;
  q?: string;
};

export const DEFAULT_RUNS_STATUS: ProjectRunStatusFilter = "open";

/** The old `?whatRan=chat` link; chats are Tasks now, so it reads as `task`. */
const LEGACY_CHAT_WHAT_RAN = "chat";

/** How long the search box waits after the last keystroke before writing `q`. */
export const RUNS_SEARCH_DEBOUNCE_MS = 300;

const RUNS_NAV_KEYS = ["status", "whatRan", "by", "item", "at", "q"] as const;

type SearchParamsLike = Pick<URLSearchParams, "get">;

const parseWith = <T>(
  schema: { safeParse: (value: string) => { success: boolean; data?: T } },
  raw: string | null,
): T | undefined => {
  if (raw === null || raw.length === 0) return undefined;
  const result = schema.safeParse(raw);
  return result.success ? result.data : undefined;
};

const parseText = (raw: string | null, max?: number): string | undefined => {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  return max === undefined ? trimmed : trimmed.slice(0, max);
};

export function parseRunsNav(searchParams: SearchParamsLike): RunsNav {
  const nav: RunsNav = {
    status:
      parseWith(projectRunStatusFilterSchema, searchParams.get("status")) ??
      DEFAULT_RUNS_STATUS,
  };
  const rawWhatRan = searchParams.get("whatRan");
  const whatRan = parseWith(
    projectRunWhatRanFilterSchema,
    rawWhatRan === LEGACY_CHAT_WHAT_RAN ? "task" : rawWhatRan,
  );
  const by = parseWith(projectRunStartedByFilterSchema, searchParams.get("by"));
  const item = parseWith(uuidV7Schema, searchParams.get("item"));
  const at = parseText(searchParams.get("at"));
  const q = parseText(searchParams.get("q"), MAX_PROJECT_RUNS_SEARCH_LENGTH);
  if (whatRan !== undefined) nav.whatRan = whatRan;
  if (by !== undefined) nav.by = by;
  if (item !== undefined) nav.item = item;
  if (at !== undefined && whatRan !== undefined) nav.at = at;
  if (q !== undefined) nav.q = q;
  return nav;
}

/**
 * Applies `patch` to `nav`; an `undefined` value clears that key. Changing
 * `whatRan` drops `at`, which names a node of the previous pipeline.
 */
export function patchRunsNav(
  nav: RunsNav,
  patch: Partial<Record<keyof RunsNav, string | undefined>>,
): RunsNav {
  const next: Record<string, string | undefined> = { ...nav, ...patch };
  if ("whatRan" in patch && !("at" in patch)) delete next["at"];
  const params = new URLSearchParams();
  for (const key of RUNS_NAV_KEYS) {
    const value = next[key];
    if (value !== undefined) params.set(key, value);
  }
  return parseRunsNav(params);
}

/** The URL for `nav` under `pathname`; the default status is left out. */
export function runsNavHref(pathname: string, nav: RunsNav): string {
  const params = new URLSearchParams();
  for (const key of RUNS_NAV_KEYS) {
    const value = nav[key];
    if (value === undefined) continue;
    if (key === "status" && value === DEFAULT_RUNS_STATUS) continue;
    params.set(key, value);
  }
  const query = params.toString();
  return query.length > 0 ? `${pathname}?${query}` : pathname;
}

/** The `GET /projects/:pid/runs` filters for `nav`, minus paging. */
export type RunsQuery = {
  status: ProjectRunStatusFilter;
  whatRan?: ProjectRunWhatRanFilter;
  startedBy?: ProjectRunStartedByFilter;
  workItemId?: string;
  atNode?: string;
  q?: string;
};

export function runsQueryOf(nav: RunsNav): RunsQuery {
  const query: RunsQuery = { status: nav.status };
  if (nav.whatRan !== undefined) query.whatRan = nav.whatRan;
  if (nav.by !== undefined) query.startedBy = nav.by;
  if (nav.item !== undefined) query.workItemId = nav.item;
  if (nav.at !== undefined) query.atNode = nav.at;
  if (nav.q !== undefined) query.q = nav.q;
  return query;
}

/** A stable key for a query, for effects that refetch when it changes. */
export const runsQueryKey = (query: RunsQuery): string =>
  JSON.stringify(Object.entries(query).sort(([a], [b]) => a.localeCompare(b)));

export const runsQueryFromKey = (key: string): RunsQuery =>
  Object.fromEntries(JSON.parse(key) as [string, string][]) as RunsQuery;
