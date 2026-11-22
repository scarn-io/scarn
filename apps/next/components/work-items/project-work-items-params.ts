import type { ScoreSortPipeline } from "@/components/work-items/filters/score-sort-catalog";
import type { WorkItemSort } from "@scarn/core/work-items/work-item/contracts/work-item-contracts";
import { parseWorkItemSortToken } from "@scarn/core/work-items/work-item/contracts/work-item-sort-token";

/**
 * Pagination and sort params for the work items page, plus the score column's
 * label. Extracted from `project-work-items-client.tsx` to keep that component
 * under the 400-line limit.
 *
 * The filter clauses live in `filters/work-item-filter-model.ts`. Sort is kept
 * out of that model on purpose: it does not reduce the result set, so it is not
 * a filter and must not count towards "is this project filtered?".
 *
 * `WorkItemSort` and its token grammar (`parseWorkItemSortToken`) are imported
 * straight from `@scarn/core`'s contracts rather than duplicated here —
 * `apps/next` already imports runtime values from deep `@scarn/core` paths
 * into client components (e.g. `DEMO_ACCOUNT_USERNAME` from
 * `@scarn/core/demo-project/demo-account` in `login-card.tsx`), and this
 * module (plus its `uuid-v7` leaf dependency) carries no server-only code, so
 * the same precedent applies. This keeps the browser and the route reading the
 * identical grammar instead of drifting onto separate copies — the mistake
 * already flagged for the `f.` prefix constant in
 * `docs/plans/work-item-filter-bar.md` Phase 6.
 */

export type { WorkItemSort };

export const DEFAULT_PAGE = 1;
export const DEFAULT_PAGE_SIZE = 25;
/** Mirrors the route's `pageSize` ceiling; a larger value is a 422. */
export const MAX_PAGE_SIZE = 100;

/**
 * `Number("abc")` is `NaN` and `Number("")` is `0`, so a junk or missing `?page=`
 * must fall back to the default rather than propagate. The data layer sanitizes
 * the value it sends too, but the component needs the same normalized number for
 * display: `pagination.page` echoes the *sanitized* page the server received, so
 * rendering the raw URL value would disagree with it (and `buildHref` would build
 * links off the junk).
 */
export const parsePageParam = (raw: string | null): number => {
  const parsed = Number(raw ?? "");
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : DEFAULT_PAGE;
};

export const parsePageSizeParam = (raw: string | null): number => {
  const parsed = Number(raw ?? "");
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= MAX_PAGE_SIZE
    ? parsed
    : DEFAULT_PAGE_SIZE;
};

/**
 * Read the `sort` URL param through the same token grammar the route parses
 * it with. Total: a missing or unrecognized token yields `undefined` rather
 * than throwing, matching every other clause's tolerance rule.
 */
export const parseWorkItemSort = (
  params: URLSearchParams,
): WorkItemSort | undefined =>
  parseWorkItemSortToken(params.get("sort") ?? undefined);

/**
 * The UI's own always-defined notion of "current sort" — the sort menu must
 * never render a blank/unchecked state. Must match the server's own silent
 * default (`work-item-listing-query.ts`'s `buildOrderBy`, `case undefined`)
 * byte-for-byte, per decision 4 in `work-item-sort.md` — the backend's
 * regression test pins that equivalence; nothing pins it here, so keep this
 * comment and that one in sync if the default ever changes.
 */
export const DEFAULT_WORK_ITEM_SORT: WorkItemSort = {
  kind: "updated",
  direction: "desc",
};

/**
 * `parseWorkItemSort`, but total in the other direction too: a missing or
 * malformed token resolves to `DEFAULT_WORK_ITEM_SORT` instead of
 * `undefined`. Use this wherever the UI needs to *display* the current sort
 * (button label, checked rows); `parseWorkItemSort` stays the answer to "was
 * a sort literally in the URL?" — a question nothing asks today, but one the
 * two functions shouldn't be conflated out of existing.
 */
export const resolveWorkItemSort = (params: URLSearchParams): WorkItemSort =>
  parseWorkItemSort(params) ?? DEFAULT_WORK_ITEM_SORT;

/**
 * The inverse of `parseWorkItemSort` — used by `SortMenu` to write a pick back
 * into the URL. Kept next to the parser so the two can't drift onto
 * mismatched spellings of the same grammar.
 */
export const formatWorkItemSort = (sort: WorkItemSort): string => {
  switch (sort.kind) {
    case "created":
    case "updated":
      return `${sort.kind}-${sort.direction}`;
    case "score":
      return `score:${sort.pipelineDefinitionId}:${sort.stepKey}:${sort.signalKey}:${sort.direction}`;
  }
};

/** Header label for the score column, e.g. `Triage · severity`. */
export const buildScoreLabel = (
  catalog: ScoreSortPipeline[],
  sortPipelineId: string | undefined,
  sortStepKey: string | undefined,
  sortResultPath: string | undefined,
): string | undefined => {
  if (!sortPipelineId || !sortStepKey || !sortResultPath) return undefined;
  const definition = catalog.find((d) => d.id === sortPipelineId);
  const step = definition?.steps.find((s) => s.stepKey === sortStepKey);
  return `${step?.name ?? sortStepKey} · ${sortResultPath}`;
};
