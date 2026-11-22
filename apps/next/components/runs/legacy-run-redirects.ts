/**
 * Where the pre-Runs project URLs (`executions`, `tasks`, `conversations`)
 * now live under `runs`. Pure: the redirect pages resolve params, call one of
 * these, and `redirect()` to the result.
 */
import { projectSubPath } from "@/app/(protected)/projects/_lib/project-routing";
import type { ProjectRunStatusFilter } from "@scarn/core/pipeline-executions/project-runs/contracts/project-runs-contracts";
import { parseUuidV7 } from "@scarn/api/frontend-contracts";
import { parseRunsNav, runsNavHref } from "./runs-params";

export type LegacySearchParams = Record<string, string | string[] | undefined>;

const first = (
  searchParams: LegacySearchParams,
  key: string,
): string | null => {
  const value = searchParams[key];
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
};

const parsePipelineIdParam = (raw: string | null): string | undefined => {
  if (raw === null || raw.length === 0) return undefined;
  try {
    return parseUuidV7(raw);
  } catch {
    return undefined;
  }
};

const withQuery = (path: string, params: URLSearchParams): string => {
  const query = params.toString();
  return query.length > 0 ? `${path}?${query}` : path;
};

/** A project's run-related path: `runs`, `runs/{id}`, `runs/tasks/{id}`. */
export type RunPathTarget =
  | { type: "list" }
  | { type: "pipeline"; id: string }
  | { type: "task"; id: string };

export function runPath(
  username: string,
  projectSlug: string,
  target: RunPathTarget,
): string {
  switch (target.type) {
    case "list":
      return projectSubPath(username, projectSlug, "runs");
    case "pipeline":
      return projectSubPath(username, projectSlug, "runs", target.id);
    case "task":
      return projectSubPath(username, projectSlug, "runs", "tasks", target.id);
  }
}

const EXECUTION_STATUS_TO_RUN_STATUS: Record<string, ProjectRunStatusFilter> = {
  running: "running",
  queued: "queued",
  waiting: "waiting",
  succeeded: "done",
  failed: "failed",
  cancelled: "cancelled",
};

/** The old executions list's `?status=` as a Runs status; unknown or absent → the Runs default. */
export const mapExecutionStatus = (
  raw: string | null,
): ProjectRunStatusFilter | undefined =>
  raw !== null && Object.hasOwn(EXECUTION_STATUS_TO_RUN_STATUS, raw)
    ? EXECUTION_STATUS_TO_RUN_STATUS[raw]
    : undefined;

const TASK_PRESET_TO_RUN_STATUS: Record<string, ProjectRunStatusFilter> = {
  needs_attention: "needs-you",
  running: "running",
  queued: "queued",
  waiting_on_blockers: "waiting",
  finished: "finished",
};

/** The old Tasks tab's `?preset=` as a Runs status; unknown or absent → the Runs default. */
export const mapTaskPreset = (
  raw: string | null,
): ProjectRunStatusFilter | undefined =>
  raw !== null && Object.hasOwn(TASK_PRESET_TO_RUN_STATUS, raw)
    ? TASK_PRESET_TO_RUN_STATUS[raw]
    : undefined;

const runsListHref = (
  username: string,
  projectSlug: string,
  nav: { status?: string | undefined; whatRan?: string | undefined },
): string => {
  const params = new URLSearchParams();
  if (nav.status !== undefined) params.set("status", nav.status);
  if (nav.whatRan !== undefined) params.set("whatRan", nav.whatRan);
  return runsNavHref(
    runPath(username, projectSlug, { type: "list" }),
    parseRunsNav(params),
  );
};

/** `executions?pipelineId&status` → `runs?whatRan&status`. */
export const legacyExecutionsHref = (
  username: string,
  projectSlug: string,
  searchParams: LegacySearchParams,
): string =>
  runsListHref(username, projectSlug, {
    whatRan: parsePipelineIdParam(first(searchParams, "pipelineId")),
    status: mapExecutionStatus(first(searchParams, "status")),
  });

/** The run page params an old `executions/[id]` link may carry. */
export const KEPT_RUN_PARAMS = [
  "step",
  "visit",
  "view",
  "filter",
  "run",
  "details",
  "focus",
  "from",
] as const;

/** `executions/[id]?…` → `runs/[id]?…`, keeping the run page's params. */
export const legacyExecutionHref = (
  username: string,
  projectSlug: string,
  executionId: string,
  searchParams: LegacySearchParams,
): string => {
  const params = new URLSearchParams();
  for (const key of KEPT_RUN_PARAMS) {
    const value = first(searchParams, key);
    if (value !== null) params.set(key, value);
  }
  return withQuery(
    runPath(username, projectSlug, { type: "pipeline", id: executionId }),
    params,
  );
};

/** `tasks?preset` → `runs?status`. */
export const legacyTasksHref = (
  username: string,
  projectSlug: string,
  searchParams: LegacySearchParams,
): string =>
  runsListHref(username, projectSlug, {
    status: mapTaskPreset(first(searchParams, "preset")),
  });

/**
 * `tasks/[id]` → the owning pipeline run, on the Task's step, when a step
 * visit created it; otherwise the Task's own run page. `task` is `null`
 * when the lookup failed (that page 404s it).
 */
export const legacyTaskHref = (
  username: string,
  projectSlug: string,
  taskId: string,
  task: { pipelineRunId: string | null; nodeId: string | null } | null,
): string => {
  if (task?.pipelineRunId) {
    const params = new URLSearchParams();
    if (task.nodeId) params.set("step", task.nodeId);
    return withQuery(
      runPath(username, projectSlug, {
        type: "pipeline",
        id: task.pipelineRunId,
      }),
      params,
    );
  }
  return runPath(username, projectSlug, { type: "task", id: taskId });
};

/** `conversations` → `runs?whatRan=task`. */
export const legacyConversationsHref = (
  username: string,
  projectSlug: string,
): string => runsListHref(username, projectSlug, { whatRan: "task" });

/** `conversations/new` → `runs?whatRan=task&compose=1` (the list opens its composer). */
export const legacyNewConversationHref = (
  username: string,
  projectSlug: string,
): string => `${legacyConversationsHref(username, projectSlug)}&compose=1`;

/**
 * `conversations/[id]` and `runs/chats/[id]` → the chat's Task page,
 * `runs/tasks/{taskId}`. `null` when the chat couldn't be read or has no
 * Task (that page 404s).
 */
export const legacyConversationHref = (
  username: string,
  projectSlug: string,
  conversation: { taskId?: string | undefined } | null,
): string | null =>
  conversation?.taskId
    ? runPath(username, projectSlug, { type: "task", id: conversation.taskId })
    : null;
