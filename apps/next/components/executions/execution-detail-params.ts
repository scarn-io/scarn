import type { LogStreamFilter } from "./log-viewer";

/** What the run page shows: a node's visit, or (no `?step=`) the landing visit. */
export type StepNavSelection =
  | { kind: "overview" }
  | {
      kind: "step";
      nodeId: string;
      /**
       * One visit of the node (a lane's visit, or one a rerun superseded).
       * `null` selects the node's default visit.
       */
      visitId: string | null;
    };

/**
 * URL-param parsing/href-building for `ExecutionDetailView`'s step selection
 * and step page (`?step=<nodeId>&visit=<visitId>`, then
 * `?view=`, `?filter=`, `?run=`, `?details=` and `?focus=`), plus the
 * rail's `?rail=graph`.
 *
 * Selection and the step page's view live entirely in the URL — no local
 * `useState` — so every change is `router.replace`d and the resulting link
 * is copy-paste shareable
 * (`docs/demo-showcase-implementation-plan.md` Phase 2a). `?focus=` is a
 * one-shot deep link to a section, spent by the first step-page change.
 *
 * `?visit=` selects one visit of the node (a lane's visit, or one superseded
 * by a rerun — `ExecutionStepItem.visits`). Absent means the node's default
 * visit: its latest current one.
 */

/** The step page's two views (`?view=`). */
export type StepView = "conversation" | "logs";

const STEP_VIEW_VALUES: readonly StepView[] = ["conversation", "logs"];

/** How the run rail shows its steps (`?rail=`). */
export type RailMode = "list" | "graph";

/** An absent or unrecognised `?rail=` is the List. */
export const parseRailParam = (searchParams: URLSearchParams): RailMode =>
  searchParams.get("rail") === "graph" ? "graph" : "list";

/** Switches the rail's mode, keeping every other param; `list` is written as absent. */
export const buildRailHref = (
  pathname: string,
  searchParams: URLSearchParams,
  mode: RailMode,
): string => {
  const next = new URLSearchParams(searchParams.toString());
  if (mode === "graph") next.set("rail", "graph");
  else next.delete("rail");
  const query = next.toString();
  return query.length > 0 ? `${pathname}?${query}` : pathname;
};

/** An absent or unrecognised `?view=` is the Conversation view. */
export const parseStepView = (searchParams: URLSearchParams): StepView =>
  STEP_VIEW_VALUES.find((value) => value === searchParams.get("view")) ??
  "conversation";

const LOG_FILTER_VALUES: readonly LogStreamFilter[] = [
  "all",
  "worker",
  "ai-server",
];

/** The Logs view's stream filter (`?filter=`); absent or unrecognised is `all`. */
export const parseLogFilter = (
  searchParams: URLSearchParams,
): LogStreamFilter =>
  LOG_FILTER_VALUES.find((value) => value === searchParams.get("filter")) ??
  "all";

/** A positive integer, or `null` for anything else. */
const parsePositiveInteger = (raw: string | null): number | null => {
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

/**
 * `?run=<runNumber>`: which run of the visit's thread the Logs view shows.
 * `null` (absent or invalid) means the latest run.
 */
export const parseRunParam = (searchParams: URLSearchParams): number | null =>
  parsePositiveInteger(searchParams.get("run"));

/**
 * What a `?focus=` deep link lands on: `artifacts` opens the Details drawer on
 * the selected visit, scrolled to Artifacts.
 */
const FOCUS_TARGET_VALUES = ["artifacts"] as const;
export type FocusTarget = (typeof FOCUS_TARGET_VALUES)[number];

/** An absent or unrecognised `?focus=` means no section is requested. */
export const parseFocusParam = (
  searchParams: URLSearchParams,
): FocusTarget | null =>
  FOCUS_TARGET_VALUES.find((value) => value === searchParams.get("focus")) ??
  null;

/** `?details=run`: the Details drawer is open on the run's overview. */
export const RUN_DETAILS = "run";

/**
 * `?details=<visitId>`: the Details drawer is open on that visit of the
 * selected node, or on the run's overview for {@link RUN_DETAILS}. Absent or
 * empty means it's closed.
 */
export const parseDetailsParam = (
  searchParams: URLSearchParams,
): string | null => searchParams.get("details") || null;

/**
 * An absent `?step=` parses as the overview; the view then lands on
 * `landingVisit` and pins it with {@link pinSelection} before any change.
 */
export const parseExecutionDetailSelection = (
  searchParams: URLSearchParams,
): StepNavSelection => {
  const nodeId = searchParams.get("step");
  if (!nodeId) return { kind: "overview" };
  return {
    kind: "step",
    nodeId,
    visitId: searchParams.get("visit") || null,
  };
};

/** The step page's own params, cleared whenever the selection changes. */
const STEP_PAGE_PARAMS = ["view", "filter", "run", "details", "focus"];

/**
 * Builds the href for a new step/overview selection. Selecting a step clears
 * the step page's params (`?view=`/`?filter=`/`?run=`/`?details=`/`?focus=`)
 * left over from the previous step — a step picked from the nav (rather than
 * followed as a link) opens on its conversation with the Details drawer
 * closed; selecting the overview clears them too, along with `?step=`.
 * `?visit=` is set only when the selection names a visit and cleared
 * otherwise, so selecting a node can't leave a stale visit selection behind.
 */
export const buildSelectionHref = (
  pathname: string,
  searchParams: URLSearchParams,
  selection: StepNavSelection,
): string => {
  const next = new URLSearchParams(searchParams.toString());
  for (const param of STEP_PAGE_PARAMS) next.delete(param);
  if (selection.kind === "step") {
    next.set("step", selection.nodeId);
    if (selection.visitId !== null) {
      next.set("visit", selection.visitId);
    } else {
      next.delete("visit");
    }
  } else {
    next.delete("step");
    next.delete("visit");
  }
  const query = next.toString();
  return query.length > 0 ? `${pathname}?${query}` : pathname;
};

/**
 * Writes a step selection into the params without touching the step page's
 * own, so a page change made on the landed visit stays on it.
 */
export const pinSelection = (
  searchParams: URLSearchParams,
  selection: StepNavSelection,
): URLSearchParams => {
  const next = new URLSearchParams(searchParams.toString());
  if (selection.kind !== "step" || next.has("step")) return next;
  next.set("step", selection.nodeId);
  if (selection.visitId !== null) next.set("visit", selection.visitId);
  return next;
};

/** A change to the step page's params; omitted keys are left as they are. */
export type StepPagePatch = {
  view?: StepView;
  filter?: LogStreamFilter;
  /** `null` shows the latest run. */
  run?: number | null;
  /** `null` closes the Details drawer. */
  details?: string | null;
};

/**
 * Patches the step page's params on the current selection. Defaults
 * (`conversation`, `all`, `null`) are written as an absent param. Any patch
 * spends the one-shot `?focus=` deep link, so it's cleared.
 */
export const buildStepPageHref = (
  pathname: string,
  searchParams: URLSearchParams,
  patch: StepPagePatch,
): string => {
  const next = new URLSearchParams(searchParams.toString());
  next.delete("focus");
  const write = (param: string, value: string | null) => {
    if (value === null) {
      next.delete(param);
    } else {
      next.set(param, value);
    }
  };
  if (patch.view !== undefined) {
    write("view", patch.view === "conversation" ? null : patch.view);
  }
  if (patch.filter !== undefined) {
    write("filter", patch.filter === "all" ? null : patch.filter);
  }
  if (patch.run !== undefined) {
    write("run", patch.run === null ? null : String(patch.run));
  }
  if (patch.details !== undefined) {
    write("details", patch.details);
  }
  const query = next.toString();
  return query.length > 0 ? `${pathname}?${query}` : pathname;
};

const splitHref = (href: string): [string, URLSearchParams] => {
  const [path = "", query = ""] = href.split("?");
  return [path, new URLSearchParams(query)];
};

/**
 * Builds a deep link that selects a step and opens one of its views, e.g.
 * `…/executions/<id>?step=reproduce` (Conversation) or
 * `…/executions/<id>?step=reproduce&view=logs`.
 *
 * Composed from the builders above so this module stays the single owner of
 * the param names — callers outside the execution detail view (e.g. the work
 * item detail page's "Latest run" card, or the project overview's guided
 * tour) never have to know them.
 */
export const buildStepViewHref = (
  pathname: string,
  searchParams: URLSearchParams,
  nodeId: string,
  view: StepView,
): string => {
  const [selectionPath, selectionParams] = splitHref(
    buildSelectionHref(pathname, searchParams, {
      kind: "step",
      nodeId,
      visitId: null,
    }),
  );
  return buildStepPageHref(selectionPath, selectionParams, { view });
};

/**
 * Builds a deep link that selects a step and scrolls to a section on load,
 * e.g. `…/executions/<id>?step=reproduce&focus=artifacts`.
 * For callers (like the guided tour's Playwright-trace card) that only care
 * about landing on a step's Artifacts.
 */
export const buildStepFocusHref = (
  pathname: string,
  searchParams: URLSearchParams,
  nodeId: string,
  focus: FocusTarget,
): string => {
  const selectionHref = buildSelectionHref(pathname, searchParams, {
    kind: "step",
    nodeId,
    visitId: null,
  });
  const [selectionPath = pathname, selectionQuery = ""] =
    selectionHref.split("?");
  return appendFocusParam(selectionPath, selectionQuery, focus);
};

const appendFocusParam = (
  pathname: string,
  query: string,
  focus: FocusTarget,
): string => {
  const next = new URLSearchParams(query);
  next.set("focus", focus);
  return `${pathname}?${next.toString()}`;
};
