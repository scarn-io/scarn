import {
  WORK_ITEM_FIELD_FILTER_PREFIX,
  type PipelineRunStatus,
  type WorkItemAgentFilter,
  type WorkItemContract,
} from "@scarn/api/frontend-contracts";

/**
 * The query model behind the work items filter bar.
 *
 * Every clause the user can express lives in the URL, and this module is the
 * only place that knows the grammar. Three functions are the whole surface:
 * `parseWorkItemFilters` reads the URL, `applyFilters` writes it back, and
 * `describeFilter` renders a clause as a chip.
 *
 * Sort is deliberately not modelled here: it does not reduce the result set, so
 * it neither belongs in the chip line nor counts towards "is this project
 * filtered?". It stays in `project-work-items-params.ts`.
 */

export type WorkItemPlatform = WorkItemContract["platform"];

export type { PipelineRunStatus, WorkItemAgentFilter };

/**
 * `me` and `none` are presets; anything else is a member's user id. The id
 * is only shape-checked here — the server drops one that names nobody.
 */
export type AssigneeFilterValue = "me" | "none" | (string & {});

export type TimeBound =
  { kind: "relative"; hours: number } | { kind: "absolute"; date: string };

export type WorkItemFilter =
  | { kind: "text"; value: string }
  | { kind: "field"; key: string; value: string }
  | { kind: "label"; value: string }
  | { kind: "updated"; after?: TimeBound; before?: TimeBound }
  | { kind: "awaitingApproval" }
  | { kind: "assignee"; value: AssigneeFilterValue }
  | { kind: "agent"; value: WorkItemAgentFilter }
  | { kind: "status"; value: PipelineRunStatus }
  | { kind: "platform"; value: WorkItemPlatform };

/** Clauses that hold exactly one enumerable value at a time. */
type SingleValues = {
  assignee: AssigneeFilterValue;
  agent: WorkItemAgentFilter;
  status: PipelineRunStatus;
  platform: WorkItemPlatform;
};

export type SingleValueFilterKind = keyof SingleValues;

export type SingleValueOf<K extends SingleValueFilterKind> = SingleValues[K];

export const singleValue = <K extends SingleValueFilterKind>(
  filters: WorkItemFilter[],
  kind: K,
): SingleValueOf<K> | undefined => {
  const match = filters.find((filter) => filter.kind === kind);
  return match && "value" in match
    ? (match.value as SingleValueOf<K>)
    : undefined;
};

/**
 * Replace the clause of `kind` with `value`, or drop it when `value` is
 * undefined. A second value for the same kind replaces the first rather than
 * widening it — the server accepts one value per param.
 */
export const withSingleValue = <K extends SingleValueFilterKind>(
  filters: WorkItemFilter[],
  kind: K,
  value: SingleValueOf<K> | undefined,
): WorkItemFilter[] => {
  const rest = filters.filter((filter) => filter.kind !== kind);
  return value === undefined
    ? rest
    : [...rest, { kind, value } as WorkItemFilter];
};

/** The labels the list is narrowed to, in URL order. */
export const activeLabels = (filters: WorkItemFilter[]): string[] =>
  filters.flatMap((filter) => (filter.kind === "label" ? [filter.value] : []));

/**
 * Add `label` as a clause, or drop it when already present. Labels combine
 * with AND: each one narrows the list further.
 */
export const withLabelToggled = (
  filters: WorkItemFilter[],
  label: string,
): WorkItemFilter[] =>
  filters.some((filter) => filter.kind === "label" && filter.value === label)
    ? filters.filter(
        (filter) => !(filter.kind === "label" && filter.value === label),
      )
    : [...filters, { kind: "label", value: label }];

/** Add `label` as a clause; a label already filtered on stays as it is. */
export const withLabelAdded = (
  filters: WorkItemFilter[],
  label: string,
): WorkItemFilter[] =>
  activeLabels(filters).includes(label)
    ? filters
    : withLabelToggled(filters, label);

/**
 * Which clauses survive a move to another project. `project` clauses are keyed
 * on a project's own dynamic `fields` data; `universal` clauses mean the same
 * thing anywhere. These URLs get shared, so the distinction is worth a colour.
 */
export type FilterTone = "project" | "universal";

export type FilterDescription = { label: string; tone: FilterTone };

// ─── URL grammar ─────────────────────────────────────────────────────────────

const TEXT_PARAM = "q";
const LABELS_PARAM = "labels";
const UPDATED_AFTER_PARAM = "updatedAfter";
const UPDATED_BEFORE_PARAM = "updatedBefore";
const AWAITING_APPROVAL_PARAM = "awaitingApproval";
const ASSIGNEE_PARAM = "assignee";
const AGENT_PARAM = "agent";
const STATUS_PARAM = "status";
const PLATFORM_PARAM = "platform";
const PAGE_PARAM = "page";

const FIXED_PARAMS = [
  TEXT_PARAM,
  LABELS_PARAM,
  UPDATED_AFTER_PARAM,
  UPDATED_BEFORE_PARAM,
  AWAITING_APPROVAL_PARAM,
  ASSIGNEE_PARAM,
  AGENT_PARAM,
  STATUS_PARAM,
  PLATFORM_PARAM,
] as const;

const fieldFilterParam = (key: string) =>
  `${WORK_ITEM_FIELD_FILTER_PREFIX}${encodeURIComponent(key)}`;

const HOURS_PER_DAY = 24;

/** `24h`, `7d` — the same grammar both `updated` bounds share. */
const RELATIVE_BOUND_PATTERN = /^(\d{1,5})([hd])$/;
const ABSOLUTE_BOUND_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export const PLATFORM_LABELS: Record<WorkItemPlatform, string> = {
  jira: "Jira",
  github: "GitHub",
  bitbucket: "Bitbucket",
  linear: "Linear",
  scarn: "Scarn",
  custom: "Custom",
};

export const AGENT_FILTER_LABELS: Record<WorkItemAgentFilter, string> = {
  waiting_on_me: "waiting on you",
  running: "running",
  queued: "queued",
  waiting_on_blockers: "waiting on blockers",
  failed: "failed",
};

/** Stored run statuses as a reader would say them; `active` is a live run. */
export const LATEST_RUN_STATUS_LABELS: Record<PipelineRunStatus, string> = {
  active: "running",
  waiting: "waiting",
  succeeded: "succeeded",
  failed: "failed",
  cancelled: "cancelled",
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isWorkItemPlatform = (value: string): value is WorkItemPlatform =>
  Object.hasOwn(PLATFORM_LABELS, value);

const isAgentFilter = (value: string): value is WorkItemAgentFilter =>
  Object.hasOwn(AGENT_FILTER_LABELS, value);

const isPipelineRunStatus = (value: string): value is PipelineRunStatus =>
  Object.hasOwn(LATEST_RUN_STATUS_LABELS, value);

const isAssigneeFilterValue = (value: string): boolean =>
  value === "me" || value === "none" || UUID_PATTERN.test(value);

/**
 * A date that the regex accepts but the calendar does not (`2026-02-31`) is
 * junk, and junk is skipped rather than propagated into a request.
 */
const isRealCalendarDate = (
  year: number,
  month: number,
  day: number,
): boolean => {
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
};

const parseTimeBound = (raw: string | null): TimeBound | undefined => {
  if (raw === null || raw.length === 0) return undefined;

  const relative = RELATIVE_BOUND_PATTERN.exec(raw);
  if (relative) {
    const amount = Number(relative[1]);
    const hours = relative[2] === "d" ? amount * HOURS_PER_DAY : amount;
    return hours > 0 ? { kind: "relative", hours } : undefined;
  }

  const absolute = ABSOLUTE_BOUND_PATTERN.exec(raw);
  if (!absolute) return undefined;
  const [, year, month, day] = absolute;
  return isRealCalendarDate(Number(year), Number(month), Number(day))
    ? { kind: "absolute", date: raw }
    : undefined;
};

/**
 * The wire form of a bound — the same string the URL carries and the listing
 * request sends. Exported so the request builder reuses this grammar rather
 * than growing a second copy of it.
 */
export const formatTimeBound = (bound: TimeBound): string =>
  bound.kind === "absolute"
    ? bound.date
    : bound.hours % HOURS_PER_DAY === 0
      ? `${String(bound.hours / HOURS_PER_DAY)}d`
      : `${String(bound.hours)}h`;

/**
 * Strict: only the literal `true` parses. Anything else — `false`, `1`,
 * garbage — is dropped rather than treated as an explicit "off", per the
 * model's total-parser rule. There is no way to write this clause into the
 * URL as anything but `true`, since `writeFilter` never emits the param at
 * all when the clause is absent.
 */
const parseAwaitingApproval = (raw: string | null): boolean => raw === "true";

// ─── Parse ───────────────────────────────────────────────────────────────────

const parseFieldFilters = (params: URLSearchParams): WorkItemFilter[] => {
  const filters: WorkItemFilter[] = [];
  for (const [param, value] of params.entries()) {
    if (!param.startsWith(WORK_ITEM_FIELD_FILTER_PREFIX)) continue;
    const encodedKey = param.slice(WORK_ITEM_FIELD_FILTER_PREFIX.length);
    if (encodedKey.length === 0 || value.length === 0) continue;
    let key: string;
    try {
      key = decodeURIComponent(encodedKey);
    } catch {
      continue;
    }
    filters.push({ kind: "field", key, value });
  }
  return filters;
};

/**
 * `labels=a,b` — comma-joined, the same grammar the listing route splits.
 * Blank and repeated entries are dropped.
 */
const parseLabelFilters = (raw: string | null): WorkItemFilter[] => {
  if (raw === null) return [];
  const labels = raw
    .split(",")
    .map((label) => label.trim())
    .filter((label) => label.length > 0);
  return [...new Set(labels)].map((value) => ({ kind: "label", value }));
};

/**
 * Read every clause the URL expresses, in a stable order regardless of the
 * order the params happen to appear in.
 *
 * Total: a clause it cannot understand is skipped, never thrown. A shared URL
 * with one malformed param still has to render the rest of the query.
 */
export const parseWorkItemFilters = (
  params: URLSearchParams,
): WorkItemFilter[] => {
  const filters: WorkItemFilter[] = [];

  const text = (params.get(TEXT_PARAM) ?? "").trim();
  if (text.length > 0) filters.push({ kind: "text", value: text });

  filters.push(...parseFieldFilters(params));
  filters.push(...parseLabelFilters(params.get(LABELS_PARAM)));

  const after = parseTimeBound(params.get(UPDATED_AFTER_PARAM));
  const before = parseTimeBound(params.get(UPDATED_BEFORE_PARAM));
  if (after || before) {
    filters.push({
      kind: "updated",
      ...(after ? { after } : {}),
      ...(before ? { before } : {}),
    });
  }

  if (parseAwaitingApproval(params.get(AWAITING_APPROVAL_PARAM))) {
    filters.push({ kind: "awaitingApproval" });
  }

  const assignee = params.get(ASSIGNEE_PARAM);
  if (assignee !== null && isAssigneeFilterValue(assignee)) {
    filters.push({ kind: "assignee", value: assignee });
  }

  const agent = params.get(AGENT_PARAM);
  if (agent !== null && isAgentFilter(agent)) {
    filters.push({ kind: "agent", value: agent });
  }

  const status = params.get(STATUS_PARAM);
  if (status !== null && isPipelineRunStatus(status)) {
    filters.push({ kind: "status", value: status });
  }

  const platform = params.get(PLATFORM_PARAM);
  if (platform !== null && isWorkItemPlatform(platform)) {
    filters.push({ kind: "platform", value: platform });
  }

  return filters;
};

// ─── Apply ───────────────────────────────────────────────────────────────────

const writeFilter = (params: URLSearchParams, filter: WorkItemFilter): void => {
  switch (filter.kind) {
    case "text": {
      const value = filter.value.trim();
      if (value.length > 0) params.set(TEXT_PARAM, value);
      return;
    }
    case "field": {
      if (filter.key.length === 0 || filter.value.length === 0) return;
      params.set(fieldFilterParam(filter.key), filter.value);
      return;
    }
    case "label": {
      const value = filter.value.trim();
      if (value.length === 0) return;
      const existing = params.get(LABELS_PARAM);
      params.set(LABELS_PARAM, existing ? `${existing},${value}` : value);
      return;
    }
    case "updated": {
      if (filter.after) {
        params.set(UPDATED_AFTER_PARAM, formatTimeBound(filter.after));
      }
      if (filter.before) {
        params.set(UPDATED_BEFORE_PARAM, formatTimeBound(filter.before));
      }
      return;
    }
    case "awaitingApproval": {
      params.set(AWAITING_APPROVAL_PARAM, "true");
      return;
    }
    case "assignee": {
      params.set(ASSIGNEE_PARAM, filter.value);
      return;
    }
    case "agent": {
      params.set(AGENT_PARAM, filter.value);
      return;
    }
    case "status": {
      params.set(STATUS_PARAM, filter.value);
      return;
    }
    case "platform": {
      params.set(PLATFORM_PARAM, filter.value);
      return;
    }
  }
};

/**
 * Rewrite every param this model owns to exactly match `filters`, dropping any
 * clause that is no longer present. Whole-set semantics rather than per-param
 * edits: the caller hands over the query it wants, not a diff.
 *
 * `page` is cleared, because any change to the clause set invalidates the
 * current page number — staying on page 4 while narrowing to a two-page result
 * shows an empty list for no visible reason. `pageSize` and the sort params are
 * not owned here and pass through untouched.
 */
export const applyFilters = (
  params: URLSearchParams,
  filters: WorkItemFilter[],
): URLSearchParams => {
  const next = new URLSearchParams(params.toString());

  const owned = [...next.keys()].filter(
    (key) =>
      key.startsWith(WORK_ITEM_FIELD_FILTER_PREFIX) ||
      FIXED_PARAMS.some((fixed) => fixed === key),
  );
  for (const key of owned) next.delete(key);

  for (const filter of filters) writeFilter(next, filter);

  next.delete(PAGE_PARAM);
  return next;
};

// ─── Describe ────────────────────────────────────────────────────────────────

/** `24 hours`, `7 days` — the plural unit a relative bound reads best in. */
const describeDuration = (hours: number): string =>
  hours % HOURS_PER_DAY === 0 && hours >= HOURS_PER_DAY * 2
    ? `${String(hours / HOURS_PER_DAY)} days`
    : `${String(hours)} hours`;

const describeBound = (bound: TimeBound): string =>
  bound.kind === "absolute"
    ? bound.date
    : `${describeDuration(bound.hours)} ago`;

const describeUpdated = (after?: TimeBound, before?: TimeBound): string => {
  if (after && before) {
    return `updated: ${describeBound(after)} – ${describeBound(before)}`;
  }
  if (after) {
    return after.kind === "absolute"
      ? `updated: after ${after.date}`
      : `updated: last ${describeDuration(after.hours)}`;
  }
  if (before) {
    return before.kind === "absolute"
      ? `updated: before ${before.date}`
      : `updated: older than ${describeDuration(before.hours)}`;
  }
  return "updated";
};

const describeAssignee = (
  value: AssigneeFilterValue,
  memberName?: (userId: string) => string | undefined,
): string => {
  if (value === "me") return "assignee: mine";
  if (value === "none") return "assignee: unassigned";
  return `assignee: ${memberName?.(value) ?? "a member"}`;
};

/**
 * The chip a clause renders as. Every label is derivable from the clause
 * itself — no project-scoped lookup is needed to read a filter back, which is
 * what lets a shared URL render correctly before any project data has loaded.
 * The one refinement is `memberName`, which names a specific assignee once
 * the project's members have loaded; without it the chip reads "a member".
 */
export const describeFilter = (
  filter: WorkItemFilter,
  memberName?: (userId: string) => string | undefined,
): FilterDescription => {
  switch (filter.kind) {
    case "text":
      return { label: filter.value, tone: "universal" };
    case "field":
      return { label: `${filter.key}: ${filter.value}`, tone: "project" };
    case "label":
      return { label: `label: ${filter.value}`, tone: "universal" };
    case "updated":
      return {
        label: describeUpdated(filter.after, filter.before),
        tone: "universal",
      };
    case "awaitingApproval":
      return { label: "awaiting approval", tone: "universal" };
    case "assignee":
      return {
        label: describeAssignee(filter.value, memberName),
        tone: "universal",
      };
    case "agent":
      return {
        label: `agent: ${AGENT_FILTER_LABELS[filter.value]}`,
        tone: "universal",
      };
    case "status":
      return {
        label: `latest run: ${LATEST_RUN_STATUS_LABELS[filter.value]}`,
        tone: "universal",
      };
    case "platform":
      return {
        label: `platform: ${PLATFORM_LABELS[filter.value]}`,
        tone: "universal",
      };
  }
};
