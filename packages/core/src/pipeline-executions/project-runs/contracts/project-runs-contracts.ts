import { startedBySchema } from "@scarn/core/common/contracts/started-by";
import { uuidV7Schema } from "@scarn/core/common/contracts/uuid-v7";
import { z } from "zod";

/**
 * The statuses people think in, derived for every kind of run: `needs-you`
 * waits on the viewer, `waiting` on someone else; `ended` reached a designed
 * fail end, `failed` crashed.
 */
export const projectRunStatusValues = [
  "needs-you",
  "waiting",
  "running",
  "queued",
  "done",
  "ended",
  "failed",
  "cancelled",
] as const;

export type ProjectRunStatus = (typeof projectRunStatusValues)[number];

/** The Runs tab's status tabs and the statuses each one shows. */
export const PROJECT_RUN_STATUS_TABS = {
  "needs-you": ["needs-you"],
  open: ["needs-you", "waiting", "running", "queued"],
  finished: ["done", "ended", "failed", "cancelled"],
  all: projectRunStatusValues,
} as const satisfies Record<string, readonly ProjectRunStatus[]>;

export type ProjectRunStatusTab = keyof typeof PROJECT_RUN_STATUS_TABS;

export const projectRunStatusTabValues = Object.keys(
  PROJECT_RUN_STATUS_TABS,
) as [ProjectRunStatusTab, ...ProjectRunStatusTab[]];

const inProgressStatuses: readonly ProjectRunStatus[] =
  PROJECT_RUN_STATUS_TABS.open;

/** Whether a run with `status` shows under In progress. */
export const isProjectRunInProgress = (status: ProjectRunStatus): boolean =>
  inProgressStatuses.includes(status);

/** The statuses a `status` filter (a tab or a single status) selects. */
export const projectRunStatusesOf = (
  filter: ProjectRunStatusFilter,
): readonly ProjectRunStatus[] =>
  filter in PROJECT_RUN_STATUS_TABS
    ? PROJECT_RUN_STATUS_TABS[filter as ProjectRunStatusTab]
    : [filter as ProjectRunStatus];

export const projectRunTypeValues = ["pipeline", "step", "task"] as const;

export type ProjectRunType = (typeof projectRunTypeValues)[number];

/**
 * What ran: the pipeline definition, the step definition, or a Task with
 * neither. `filter` is the value the list's `whatRan` filter takes.
 */
export const projectRunWhatRanSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pipeline"), id: uuidV7Schema, name: z.string() }),
  z.object({ kind: z.literal("step"), id: uuidV7Schema, name: z.string() }),
  z.object({ kind: z.literal("task"), name: z.string() }),
]);

const workItemRefSchema = z.object({
  id: uuidV7Schema,
  platformKey: z.string(),
  title: z.string(),
});

const runPersonSchema = z.object({
  userId: uuidV7Schema,
  /** `null` when unresolved. */
  username: z.string().nullable(),
});

/**
 * One row of the Runs list: a pipeline run, or a Task started on its own (a
 * single step, a prompt, or a Task without a work item). A pipeline run's
 * step Tasks are never rows of their own.
 */
export const projectRunSchema = z.object({
  type: z.enum(projectRunTypeValues),
  /** The execution id or the Task id. */
  id: uuidV7Schema,
  /** Relative to the project: `runs/{id}` or `runs/tasks/{id}`. */
  href: z.string(),
  /**
   * The work item's title; a prompt Task's first line; a Task without a work
   * item's first conversation message.
   */
  title: z.string(),
  whatRan: projectRunWhatRanSchema,
  /** `null` for a Task without a work item. */
  workItem: workItemRefSchema
    .extend({ parent: workItemRefSchema.nullable() })
    .nullable(),
  status: z.enum(projectRunStatusValues),
  /** One line on where the run is or how it finished. */
  statusLine: z.string(),
  /**
   * An `ended` run's fail-end error label, or a `failed` run's or Task's
   * error code; otherwise `null`.
   */
  outcome: z.string().nullable(),
  /** The nodes a pipeline run is currently at; empty for Tasks. */
  openNodeIds: z.array(z.string()),
  /** True when the run waits on the viewer in particular; false for guests. */
  waitingOnYou: z.boolean(),
  /** The people the run waits on; empty unless it is waiting. */
  waitingOn: z.array(runPersonSchema),
  startedBy: startedBySchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

/** How one run is looked up: a `step` row is reached as a `task`. */
export const projectRunLookupKindValues = ["pipeline", "task"] as const;

export type ProjectRunLookupKind = (typeof projectRunLookupKindValues)[number];

export const getProjectRunParamsSchema = z.object({
  projectId: uuidV7Schema,
  type: z.enum(projectRunLookupKindValues),
  id: uuidV7Schema,
});

export type GetProjectRunParams = z.infer<typeof getProjectRunParamsSchema>;

export const DEFAULT_PROJECT_RUNS_LIMIT = 50;
export const MAX_PROJECT_RUNS_LIMIT = 100;
export const MAX_PROJECT_RUNS_SEARCH_LENGTH = 200;

/** A tab, or one status. */
export const projectRunStatusFilterSchema = z.union([
  z.enum(projectRunStatusTabValues),
  z.enum(projectRunStatusValues),
]);

export type ProjectRunStatusFilter = z.infer<
  typeof projectRunStatusFilterSchema
>;

/** A pipeline definition id, a step definition id, or `task`. */
export const projectRunWhatRanFilterSchema = z.union([
  uuidV7Schema,
  z.literal("task"),
]);

/**
 * An automation id (runs it started without a person), `me` for runs the
 * viewer started, or `scheduled` for Tasks a schedule rule started (by the
 * tick or Run now).
 */
export const projectRunStartedByFilterSchema = z.union([
  uuidV7Schema,
  z.literal("me"),
  z.literal("scheduled"),
]);

export const listProjectRunsQuerySchema = z.object({
  status: projectRunStatusFilterSchema.default("all"),
  whatRan: projectRunWhatRanFilterSchema.optional(),
  startedBy: projectRunStartedByFilterSchema.optional(),
  /** The work item or any of its children. */
  workItemId: uuidV7Schema.optional(),
  /** Only the Tasks this schedule started, removed or not: the schedule's history. */
  scheduleId: uuidV7Schema.optional(),
  /** With a pipeline `whatRan`: runs whose `openNodeIds` include it. */
  atNode: z.string().min(1).optional(),
  /** Matches the title, key, pipeline name, status line and node ids. */
  q: z.string().trim().min(1).max(MAX_PROJECT_RUNS_SEARCH_LENGTH).optional(),
  /** The previous page's `nextCursor`. */
  before: z.string().min(1).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PROJECT_RUNS_LIMIT)
    .default(DEFAULT_PROJECT_RUNS_LIMIT),
});

const facetCountSchema = z.object({
  /** Runs in progress (needs-you, waiting, running, queued). */
  inProgress: z.number().int().nonnegative(),
  /** Whether any run needs the viewer. */
  needsYou: z.boolean(),
});

/**
 * Totals for the current scope (every filter but `status` and `before`):
 * one per tab, and the sidebar's in-progress counts per facet value.
 */
export const projectRunsCountsSchema = z.object({
  tabs: z.record(
    z.enum(projectRunStatusTabValues),
    z.number().int().nonnegative(),
  ),
  overall: facetCountSchema,
  startedBy: z.array(
    facetCountSchema.extend({
      /** The `startedBy` filter value. */
      filter: projectRunStartedByFilterSchema,
      /** The automation's title or key, `You`, or `Scheduled`. */
      label: z.string(),
    }),
  ),
  whatRan: z.array(
    facetCountSchema.extend({
      /** The `whatRan` filter value. */
      filter: projectRunWhatRanFilterSchema,
      whatRan: projectRunWhatRanSchema,
    }),
  ),
});

/** A project's runs, most recently updated first. */
export const projectRunsPageSchema = z.object({
  runs: z.array(projectRunSchema),
  /** Pass as `before` for the next page; `null` on the last page. */
  nextCursor: z.string().nullable(),
  counts: projectRunsCountsSchema,
});

const nodeLiveCountSchema = z.object({
  /** Open visits at the node whose work is queued or running. */
  running: z.number().int().nonnegative(),
  /** Open visits at the node waiting on a person or an event. */
  waiting: z.number().int().nonnegative(),
  /**
   * Uncaught failed visits at the node: on in-progress runs (a failed lane),
   * or on runs that crashed there in the last 7 days.
   */
  failed: z.number().int().nonnegative(),
  /** Distinct fan-out lanes with an open visit at the node; 0 outside a fan-out. */
  lanes: z.number().int().nonnegative(),
});

/** Live run counts per pipeline definition of a project, for its graph cards. */
export const pipelineLiveCountsSchema = z.object({
  pipelines: z.array(
    z.object({
      pipelineDefinitionId: uuidV7Schema,
      /** Runs in progress (needs-you, waiting, running, queued). */
      inProgress: z.number().int().nonnegative(),
      /** Runs that succeeded in the last 7 days. */
      doneThisWeek: z.number().int().nonnegative(),
      /** By node id; nodes with nothing to count are absent. */
      nodes: z.record(z.string(), nodeLiveCountSchema),
    }),
  ),
});

export type PipelineLiveCountsContract = z.infer<
  typeof pipelineLiveCountsSchema
>;
export type ProjectRunWhatRan = z.infer<typeof projectRunWhatRanSchema>;
export type ProjectRunContract = z.infer<typeof projectRunSchema>;
export type ProjectRunWhatRanFilter = z.infer<
  typeof projectRunWhatRanFilterSchema
>;
export type ProjectRunStartedByFilter = z.infer<
  typeof projectRunStartedByFilterSchema
>;
export type ListProjectRunsQuery = z.infer<typeof listProjectRunsQuerySchema>;
export type ListProjectRunsQueryInput = z.input<
  typeof listProjectRunsQuerySchema
>;
export type ProjectRunsCountsContract = z.infer<typeof projectRunsCountsSchema>;
export type ProjectRunsPageContract = z.infer<typeof projectRunsPageSchema>;
