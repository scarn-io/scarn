import { and, eq, ilike, isNull, or, sql, type SQL } from "drizzle-orm";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { workItems } from "@scarn/core/lib/db/schema";
import type { PipelineRunStatus } from "@scarn/core/pipeline-executions/pipeline-run/domain/pipeline-run-entity";
import {
  MAX_FIELD_OPTION_KEYS,
  MAX_FIELD_OPTION_VALUES,
  type WorkItemTaskStatusCounts,
} from "../contracts/work-item-contracts";
import type {
  WorkItemFieldOption,
  WorkItemListPageOptions,
  WorkItemListSort,
} from "../application/work-item-repo";
import {
  buildLatestSignalScoresSubquery,
  LATEST_SCORE_COLUMN,
  LATEST_SCORES_ALIAS,
} from "./work-item-signal-score-subquery";
import {
  buildLatestExecutionStatusPredicate,
  buildLatestExecutionStatusSubquery,
  LATEST_EXECUTION_STATUS_ALIAS,
  LATEST_EXECUTION_STATUS_COLUMN,
  LATEST_EXECUTION_STATUS_WORK_ITEM_ID_COLUMN,
} from "./work-item-latest-execution-status-subquery";
import {
  ALIAS as AWAITING_APPROVAL_ALIAS,
  AWAITING_APPROVAL_CHANNEL,
  AWAITING_APPROVAL_STATUSES,
  buildAwaitingApprovalSubquery,
  COLUMN as AWAITING_APPROVAL_COLUMN,
  WORK_ITEM_ID_COLUMN as AWAITING_APPROVAL_WORK_ITEM_ID_COLUMN,
} from "./work-item-awaiting-approval-subquery";
import {
  buildAgentFilterPredicate,
  buildTaskStatusCountsSubquery,
  TASK_STATUS_COUNTS_ALIAS,
  TASK_STATUS_COUNTS_WORK_ITEM_ID_COLUMN,
  taskStatusCountsSelection,
  toTaskStatusCounts,
} from "./work-item-task-status-subquery";

/** A raw `work_items` row, as handed back to the repo's `toEntity` mapper. */
export type WorkItemRow = typeof workItems.$inferSelect;

export type WorkItemListPageRows = {
  rows: {
    workItem: WorkItemRow;
    signalScore: number | null;
    latestExecutionStatus: PipelineRunStatus | null;
    awaitingApprovalCount: number;
    taskStatusCounts: WorkItemTaskStatusCounts;
  }[];
  /** Rows matching the filters, independent of the requested page. */
  total: number;
};

/** Row shape of the field-options query, before grouping. */
export type WorkItemFieldOptionRow = {
  key: string | null;
  value: string | null;
};

/**
 * Escape the `LIKE`/`ILIKE` metacharacters so user input matches literally.
 *
 * The backslash must be escaped first: it is Postgres' default `LIKE` escape
 * character, so an unescaped one would swallow the character following it.
 */
export const escapeLikeWildcards = (value: string): string =>
  value.replace(/[\\%_]/g, (match) => `\\${match}`);

/** `%needle%`, with the needle's wildcards neutralised. */
export const toContainsPattern = (search: string): string =>
  `%${escapeLikeWildcards(search)}%`;

/**
 * When the item last changed, preferring the source platform's own clock and
 * falling back to our sync clock for items that never carried one.
 *
 * Deliberately shared by the `updated` filter and the default `ORDER BY`: the
 * two have to agree. A bare `source_updated_at` predicate would treat an item
 * with no source timestamp as `NULL` and drop it, even though that same item
 * sorts by `updated_at` and is visible in the unfiltered list.
 *
 * This is also the expression `work_items_project_source_updated_idx` is built
 * on, so keep the three in step.
 */
const EFFECTIVE_UPDATED_AT = sql`coalesce(${workItems.sourceUpdatedAt}, ${workItems.updatedAt})`;

const HOURS_PER_DAY = 24;
const MS_PER_HOUR = 60 * 60 * 1000;
const RELATIVE_BOUND_PATTERN = /^(\d{1,5})([hd])$/;
const ABSOLUTE_BOUND_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Turn a validated `WorkItemTimeBound` into the instant it names. `now` is the
 * caller's `TimeProvider` value rather than SQL `now()`, so a fixed clock still
 * pins the window in tests. An absolute bound is the start of its day in UTC.
 */
const resolveTimeBound = (bound: string, now: Date): Date | undefined => {
  const relative = RELATIVE_BOUND_PATTERN.exec(bound);
  if (relative) {
    const amount = Number(relative[1]);
    const hours = relative[2] === "d" ? amount * HOURS_PER_DAY : amount;
    return new Date(now.getTime() - hours * MS_PER_HOUR);
  }

  if (!ABSOLUTE_BOUND_PATTERN.test(bound)) return undefined;
  const absolute = new Date(`${bound}T00:00:00.000Z`);
  return Number.isNaN(absolute.getTime()) ? undefined : absolute;
};

const boundParam = (instant: Date): SQL =>
  sql`${instant.toISOString()}::timestamptz`;

/**
 * `WHERE` fragments shared by the page query and the fallback count. None of
 * them reference the score subquery, which is why the count can omit the join.
 */
const buildFilterPredicates = (
  projectId: UuidV7,
  options: Pick<
    WorkItemListPageOptions,
    | "search"
    | "fieldFilters"
    | "labels"
    | "updatedAfter"
    | "updatedBefore"
    | "awaitingApproval"
    | "viewerUserId"
    | "assignee"
    | "agent"
    | "latestExecutionStatus"
    | "platform"
  >,
  now: Date,
): SQL[] => {
  const predicates: SQL[] = [eq(workItems.projectId, projectId)];

  const search = options.search?.trim();
  if (search !== undefined && search.length > 0) {
    const pattern = toContainsPattern(search);
    const searchGroup = or(
      ilike(workItems.title, pattern),
      ilike(workItems.description, pattern),
      ilike(workItems.platformKey, pattern),
      ilike(workItems.platformId, pattern),
      ilike(workItems.url, pattern),
      // `platform` is an enum, so it needs an explicit text cast to be ILIKE-able.
      sql`${workItems.platform}::text ilike ${pattern}`,
    );
    if (searchGroup) {
      predicates.push(searchGroup);
    }
  }

  for (const filter of options.fieldFilters ?? []) {
    // A missing key yields NULL, so the comparison is false and the row is
    // excluded — matching the previous client-side `matchesFieldFilters`.
    predicates.push(
      sql`${workItems.fields} ->> ${filter.key}::text = ${filter.value}`,
    );
  }

  const labels = options.labels ?? [];
  if (labels.length > 0) {
    predicates.push(
      sql`${workItems.labels} @> array[${sql.join(
        labels.map((label) => sql`${label}`),
        sql`, `,
      )}]::text[]`,
    );
  }

  // Half-open, so `updatedAfter=2026-01-01&updatedBefore=2026-02-01` is exactly
  // January and two adjacent ranges can never both claim the same item.
  const after = options.updatedAfter
    ? resolveTimeBound(options.updatedAfter, now)
    : undefined;
  if (after) {
    predicates.push(sql`${EFFECTIVE_UPDATED_AT} >= ${boundParam(after)}`);
  }

  const before = options.updatedBefore
    ? resolveTimeBound(options.updatedBefore, now)
    : undefined;
  if (before) {
    predicates.push(sql`${EFFECTIVE_UPDATED_AT} < ${boundParam(before)}`);
  }

  // Self-contained — correlated on `workItems.id` only, no outer alias — so
  // the fallback count above keeps working untouched. The caller (`listWorkItemsByProject`)
  // is the only place `options.awaitingApproval` is set, and only after
  // confirming `work-item-platform-comment:create` — the same permission
  // that gates the pending-draft card on the detail page — so this predicate
  // carries no authorization logic of its own.
  if (options.awaitingApproval) {
    predicates.push(sql`exists (
      select 1
      from app.notification_deliveries d
      join app.user_notifications n on n.id = d.notification_id
      where n.work_item_id = ${workItems.id}
        and d.channel::text = ${AWAITING_APPROVAL_CHANNEL}
        and d.status::text in (${sql.join(
          AWAITING_APPROVAL_STATUSES.map((status) => sql`${status}`),
          sql`, `,
        )})
    )`);
  }

  if (options.agent) {
    predicates.push(
      buildAgentFilterPredicate(options.agent, options.viewerUserId),
    );
  }

  if (options.assignee?.kind === "user") {
    predicates.push(eq(workItems.assigneeUserId, options.assignee.userId));
  } else if (options.assignee?.kind === "none") {
    predicates.push(isNull(workItems.assigneeUserId));
  }

  if (options.platform) {
    predicates.push(eq(workItems.platform, options.platform));
  }

  if (options.latestExecutionStatus) {
    predicates.push(
      buildLatestExecutionStatusPredicate(options.latestExecutionStatus),
    );
  }

  return predicates;
};

/**
 * `NULLS LAST` is spelled out in both directions on the `score` branch on
 * purpose: Postgres defaults `DESC` to `NULLS FIRST`, which would surface
 * unscored items first. `created_at`/`updated_at` are `NOT NULL` columns, so
 * the concern doesn't apply to the `created`/`updated` branches. Every branch's
 * tiebreaker chain ends in `id` so paging cannot duplicate or skip a row.
 */
const buildOrderBy = (
  sort: WorkItemListSort | undefined,
  scoreExpression: SQL | null, // only meaningful when sort.kind === "score"
): SQL[] => {
  switch (sort?.kind) {
    case "created":
      return [
        sql`${workItems.createdAt} ${sql.raw(sort.direction)}`,
        sql`${workItems.id} ${sql.raw(sort.direction)}`,
      ];
    case "updated":
      return [
        sql`${EFFECTIVE_UPDATED_AT} ${sql.raw(sort.direction)}`,
        sql`${workItems.updatedAt} ${sql.raw(sort.direction)}`,
        sql`${workItems.createdAt} ${sql.raw(sort.direction)}`,
        sql`${workItems.id} ${sql.raw(sort.direction)}`,
      ];
    case "score":
      // Unchanged from today: score first with NULLS LAST in both
      // directions, then the same fixed desc tail as the no-sort default.
      return [
        sort.direction === "asc"
          ? sql`${scoreExpression} asc nulls last`
          : sql`${scoreExpression} desc nulls last`,
        sql`${EFFECTIVE_UPDATED_AT} desc`,
        sql`${workItems.updatedAt} desc`,
        sql`${workItems.createdAt} desc`,
        sql`${workItems.id} desc`,
      ];
    case undefined:
      // Today's silent default, unchanged (decision 4,
      // `docs/plans/work-item-sort.md`): no `sort` param still means
      // `coalesce(source_updated_at, updated_at) desc`, not GitHub's own
      // default of `created-desc`. Do not "fix" this — the `updated-desc`
      // regression test in `project-work-items.sort.test.ts` guards against
      // an accidental drift here.
      return [
        sql`${EFFECTIVE_UPDATED_AT} desc`,
        sql`${workItems.updatedAt} desc`,
        sql`${workItems.createdAt} desc`,
        sql`${workItems.id} desc`,
      ];
  }
};

const toNullableNumber = (value: string | number | null): number | null => {
  if (value === null) {
    return null;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const countMatchingWorkItems = async (
  db: DbExecutor,
  predicates: SQL[],
): Promise<number> => {
  const [row] = await db
    .select({ total: sql<string>`count(*)` })
    .from(workItems)
    .where(and(...predicates));

  return toNullableNumber(row?.total ?? null) ?? 0;
};

/**
 * One page of a project's work items with filtering, signal-score sorting, and
 * the total match count resolved in a single round trip.
 *
 * `now` binds the `updatedAfter`/`updatedBefore` relative bounds. Always a
 * `TimeProvider` value, never SQL `now()`, so `fixedTimeProvider` still
 * controls them in tests.
 */
export const queryWorkItemListPage = async (
  db: DbExecutor,
  projectId: UuidV7,
  options: WorkItemListPageOptions,
  now: Date,
): Promise<WorkItemListPageRows> => {
  const predicates = buildFilterPredicates(projectId, options, now);
  const sort = options.sort;
  const latestScores =
    sort?.kind === "score"
      ? buildLatestSignalScoresSubquery(db, projectId, sort)
      : null;

  // Referenced by explicit identifier rather than through the subquery proxy so
  // the same expression renders identically in the select list and ORDER BY.
  const scoreExpression = latestScores
    ? sql<
        string | null
      >`${sql.identifier(LATEST_SCORES_ALIAS)}.${sql.identifier(LATEST_SCORE_COLUMN)}`
    : null;

  // Unlike `latestScores`, this join is unconditional: the plan asks only for
  // display, never sorting, so there is no `options`-driven gate.
  const latestExecutionStatus = buildLatestExecutionStatusSubquery(projectId);
  const statusExpression = sql<
    string | null
  >`${sql.identifier(LATEST_EXECUTION_STATUS_ALIAS)}.${sql.identifier(LATEST_EXECUTION_STATUS_COLUMN)}`;

  // Unlike `latestExecutionStatus`, this join IS gated — but on the
  // permission `listWorkItemsByProject` already resolved into
  // `includeAwaitingApprovalData`, never on whether `awaitingApproval` was
  // requested (decision 14): an unauthorized caller's query must never touch
  // `notification_deliveries`, computed-then-masked or otherwise.
  const awaitingApproval = options.includeAwaitingApprovalData
    ? buildAwaitingApprovalSubquery(projectId)
    : null;
  const awaitingApprovalCountExpression = awaitingApproval
    ? sql<
        number | string
      >`coalesce(${sql.identifier(AWAITING_APPROVAL_ALIAS)}.${sql.identifier(AWAITING_APPROVAL_COLUMN)}, 0)`
    : sql<number>`0`;

  const taskStatusCounts = buildTaskStatusCountsSubquery(
    projectId,
    options.viewerUserId,
  );

  let query = db
    .select({
      workItem: {
        id: workItems.id,
        projectId: workItems.projectId,
        platform: workItems.platform,
        platformId: workItems.platformId,
        platformKey: workItems.platformKey,
        url: workItems.url,
        title: workItems.title,
        description: workItems.description,
        descriptionVersion: workItems.descriptionVersion,
        sourceCreatedAt: workItems.sourceCreatedAt,
        sourceUpdatedAt: workItems.sourceUpdatedAt,
        fields: workItems.fields,
        labels: workItems.labels,
        createdByUserId: workItems.createdByUserId,
        assigneeUserId: workItems.assigneeUserId,
        parentWorkItemId: workItems.parentWorkItemId,
        state: workItems.state,
        closeReason: workItems.closeReason,
        resolution: workItems.resolution,
        closedAt: workItems.closedAt,
        closedByUserId: workItems.closedByUserId,
        closedByTaskId: workItems.closedByTaskId,
        spawnedByTaskId: workItems.spawnedByTaskId,
        createdAt: workItems.createdAt,
        updatedAt: workItems.updatedAt,
      },
      score: scoreExpression ?? sql<string | null>`null::numeric`,
      latestExecutionStatus: statusExpression,
      awaitingApprovalCount: awaitingApprovalCountExpression,
      taskStatusCounts: taskStatusCountsSelection(),
      // bigint, so the driver hands it back as a string.
      total: sql<string>`count(*) over ()`,
    })
    .from(workItems)
    .$dynamic();

  if (latestScores) {
    query = query.leftJoin(
      latestScores,
      eq(latestScores.workItemId, workItems.id),
    );
  }

  query = query.leftJoin(
    latestExecutionStatus,
    sql`${sql.identifier(LATEST_EXECUTION_STATUS_ALIAS)}.${sql.identifier(LATEST_EXECUTION_STATUS_WORK_ITEM_ID_COLUMN)} = ${workItems.id}`,
  );

  query = query.leftJoin(
    taskStatusCounts,
    sql`${sql.identifier(TASK_STATUS_COUNTS_ALIAS)}.${sql.identifier(TASK_STATUS_COUNTS_WORK_ITEM_ID_COLUMN)} = ${workItems.id}`,
  );

  if (awaitingApproval) {
    query = query.leftJoin(
      awaitingApproval,
      sql`${sql.identifier(AWAITING_APPROVAL_ALIAS)}.${sql.identifier(AWAITING_APPROVAL_WORK_ITEM_ID_COLUMN)} = ${workItems.id}`,
    );
  }

  const rows = await query
    .where(and(...predicates))
    .orderBy(...buildOrderBy(sort, scoreExpression))
    .limit(options.pageSize)
    .offset((options.page - 1) * options.pageSize);

  const firstRow = rows[0];
  if (!firstRow) {
    // The window function reports 0 for an out-of-range page, so the real total
    // has to come from a separate count. Page 1 being empty genuinely means 0.
    return {
      rows: [],
      total:
        options.page > 1 ? await countMatchingWorkItems(db, predicates) : 0,
    };
  }

  return {
    rows: rows.map((row) => ({
      workItem: row.workItem,
      signalScore: toNullableNumber(row.score),
      latestExecutionStatus:
        row.latestExecutionStatus as PipelineRunStatus | null,
      awaitingApprovalCount: toNullableNumber(row.awaitingApprovalCount) ?? 0,
      taskStatusCounts: toTaskStatusCounts(row.taskStatusCounts),
    })),
    total: toNullableNumber(firstRow.total) ?? 0,
  };
};

/**
 * Collapse the flat `(key, value)` result set into per-key option lists,
 * reproducing the previous client-side `deriveFieldFilterOptions` ordering
 * (`localeCompare` on keys and values) so the dropdowns look unchanged.
 */
export const groupFieldOptionRows = (
  rows: WorkItemFieldOptionRow[],
): WorkItemFieldOption[] => {
  const valuesByKey = new Map<string, Set<string>>();

  for (const row of rows) {
    const { key, value } = row;
    if (key === null || value === null) {
      continue;
    }
    let values = valuesByKey.get(key);
    if (!values) {
      values = new Set<string>();
      valuesByKey.set(key, values);
    }
    values.add(value);
  }

  return [...valuesByKey.entries()]
    .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
    .slice(0, MAX_FIELD_OPTION_KEYS)
    .map(([key, values]) => {
      const sorted = [...values].sort((left, right) =>
        left.localeCompare(right),
      );
      return {
        key,
        values: sorted.slice(0, MAX_FIELD_OPTION_VALUES),
        truncated: sorted.length > MAX_FIELD_OPTION_VALUES,
      };
    });
};

/**
 * Distinct scalar `fields` keys and values across a project.
 *
 * `jsonb_typeof` filtering to string/number/boolean mirrors the previous
 * `isScalarFieldValue` guard, excluding objects, arrays, and JSON nulls;
 * `#>> '{}'` extracts the scalar as text, matching `String(value)`.
 */
export const queryWorkItemFieldOptions = async (
  db: DbExecutor,
  projectId: UuidV7,
): Promise<WorkItemFieldOption[]> => {
  const fieldsColumn = sql`w.${sql.identifier(workItems.fields.name)}`;
  const projectIdColumn = sql`w.${sql.identifier(workItems.projectId.name)}`;

  const rows = await db.execute<WorkItemFieldOptionRow>(sql`
    select "key", "value"
    from (
      select distinct
        f.key as "key",
        f.value #>> '{}' as "value"
      from ${workItems} as w
      cross join lateral jsonb_each(
        case
          when jsonb_typeof(${fieldsColumn}) = 'object' then ${fieldsColumn}
          else '{}'::jsonb
        end
      ) as f(key, value)
      where ${projectIdColumn} = ${projectId}::uuid
        and jsonb_typeof(f.value) in ('string', 'number', 'boolean')
    ) t
    order by "key", "value"
  `);

  return groupFieldOptionRows(rows.rows);
};
