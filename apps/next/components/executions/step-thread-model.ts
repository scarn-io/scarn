/**
 * Pure helpers for the step thread's run sections: the cause line, the status
 * word and whether a run is still live. A run is one Task in the visit's
 * thread; its timings come from the visit Tasks the run detail already
 * carries, so collapsed sections need no log reads.
 */
import type {
  NodeVisitContract,
  VisitThreadContract,
} from "@scarn/api/frontend-contracts";

type ThreadRunContract = VisitThreadContract["runs"][number];

export type StepThreadRun = ThreadRunContract & {
  /** 1-based position in the thread, oldest first. */
  runNumber: number;
  /** The visit that queued this Task; `null` when it isn't in the run detail. */
  visitId: string | null;
  /** The Task's attempt within its visit; retries count up from 1. */
  attemptNumber: number;
  startedAt: string | null;
  completedAt: string | null;
  workBranch: string | null;
};
export type ThreadRunStatus = StepThreadRun["status"];

/**
 * Why the run started: the person's message, the pipeline, a retry of the
 * same visit, or a rerun that superseded an earlier visit.
 */
export function runCause(
  run: Pick<StepThreadRun, "runNumber" | "attemptNumber" | "messages">,
): string {
  if (run.messages.length > 0) return "From your message";
  if (run.attemptNumber > 1) return `Retry ${String(run.attemptNumber - 1)}`;
  if (run.runNumber === 1) return "Started by pipeline";
  return "Re-run";
}

const LIVE_STATUSES: ReadonlySet<ThreadRunStatus> = new Set([
  "pending",
  "queued",
  "running",
]);

/** The task hasn't reached a terminal status, so its logs may still grow. */
export const isRunLive = (status: ThreadRunStatus): boolean =>
  LIVE_STATUSES.has(status);

export type RunTailIndicator = "spinning-up" | "thinking" | null;

/**
 * What the live tail of a run shows: nothing while the run waits for a worker
 * (`pending`/`queued`), "spinning up" once a worker has claimed it but the
 * agent hasn't emitted any conversation yet, and "thinking" while the agent
 * works between activity rows.
 */
export function runTailIndicator({
  status,
  hasConversation,
  activityActive,
}: {
  status: ThreadRunStatus;
  hasConversation: boolean;
  activityActive: boolean;
}): RunTailIndicator {
  if (status !== "running") return null;
  if (!hasConversation) return "spinning-up";
  return activityActive ? null : "thinking";
}

const STATUS_WORDS: Record<ThreadRunStatus, string> = {
  pending: "pending",
  queued: "queued",
  running: "running",
  yielded: "waiting for you",
  succeeded: "done",
  failed: "failed",
  timeout: "timed out",
  abandoned: "abandoned",
  cancelled: "stopped",
  skipped: "skipped",
};

export const runStatusWord = (status: ThreadRunStatus): string =>
  STATUS_WORDS[status];

/**
 * Whether a continuation picked up the agent's saved session or fell back to
 * the transcript of the run before it; `null` when there was nothing to
 * restore.
 */
export function sessionNote(
  run: Pick<StepThreadRun, "sessionRestored">,
): string | null {
  if (run.sessionRestored === null) return null;
  return run.sessionRestored
    ? "Resumed its session"
    : "Session not restored; continued from the transcript";
}

/** The run's duration in ms, or `null` before it starts. */
export function runDurationMs(
  run: Pick<StepThreadRun, "startedAt" | "completedAt">,
  nowMs: number,
): number | null {
  if (!run.startedAt) return null;
  const start = Date.parse(run.startedAt);
  const end = run.completedAt ? Date.parse(run.completedAt) : nowMs;
  return Math.max(0, end - start);
}

/**
 * Joins a visit thread's runs with the visit Tasks from the run detail, which
 * carry the timings and the liveness-adjusted status (`abandoned`/`timeout`).
 */
export function buildThreadRuns(
  runs: readonly ThreadRunContract[],
  visits: readonly NodeVisitContract[],
): StepThreadRun[] {
  const byTaskId = new Map(
    visits.flatMap((visit) =>
      visit.tasks.map((task) => [task.taskId, { visit, task }] as const),
    ),
  );
  return runs.map((run, index) => {
    const match = byTaskId.get(run.taskRunId);
    return {
      ...run,
      status: match?.task.status ?? run.status,
      runNumber: index + 1,
      visitId: match?.visit.id ?? null,
      attemptNumber: match?.task.attemptNumber ?? 1,
      startedAt: match?.task.startedAt ?? null,
      completedAt: match?.task.completedAt ?? null,
      workBranch: match?.task.workBranch ?? null,
    };
  });
}

/**
 * A visit with no thread to read (a lane's visit of a code step, or before
 * the thread loads) still shows its own Tasks as run sections, without the
 * messages only the thread carries.
 */
export function visitThreadRuns(visit: NodeVisitContract): StepThreadRun[] {
  return visit.tasks.map((task, index) => ({
    taskRunId: task.taskId,
    previousTaskRunId: visit.tasks[index - 1]?.taskId ?? null,
    status: task.status,
    createdAt: task.startedAt ?? visit.createdAt,
    messages: [],
    sessionRestored: null,
    runNumber: index + 1,
    visitId: visit.id,
    attemptNumber: task.attemptNumber,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    workBranch: task.workBranch,
  }));
}
