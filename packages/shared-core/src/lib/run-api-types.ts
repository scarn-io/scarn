/**
 * Minimal, nullable-correct mirrors of the pipeline-run response bodies
 * the `runs list` / `runs thread` commands read (see
 * `./api-types.ts` for why this package does not import the generated
 * types). Only the fields the formatters use are typed; `--json` prints the
 * whole body as received.
 */

export type RunDisplayStatus =
  "queued" | "running" | "waiting" | "succeeded" | "failed" | "cancelled";

export const RUN_DISPLAY_STATUSES: readonly RunDisplayStatus[] = [
  "queued",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "cancelled",
];

export type RunError = { name: string; message: string };

/** One row of `GET /pipeline-executions`. */
export type RunListItem = {
  id: string;
  workItemId: string;
  workItemTitle: string;
  pipelineDefinitionId: string;
  status: RunDisplayStatus;
  waitingFor: "decision" | "reply" | null;
  error: RunError | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  openNodeIds: string[];
};

export type RunListPage = {
  items: RunListItem[];
  pagination: { page: number; pageSize: number; total: number };
};

/** One run of a visit's Task. */
export type RunVisitTask = {
  taskId: string;
  attemptNumber: number;
  status: string;
};

/** One visit of `GET /pipeline-executions/{id}`'s `visits`. */
export type RunVisit = {
  id: string;
  nodeId: string;
  nodeKind: "step" | "wait" | "succeed" | "fail";
  status: string;
  tasks: RunVisitTask[];
  createdAt: string;
  completedAt: string | null;
};

/** `GET /pipeline-executions/{id}`, visits only. */
export type RunWithVisits = {
  id: string;
  workItemId: string;
  workItemTitle: string;
  pipelineDefinitionId: string;
  status: RunDisplayStatus;
  visits: RunVisit[];
};

export type VisitThreadMessage = {
  id: string;
  taskId: string;
  authorUserId: string;
  body: string;
  quoteText: string | null;
  createdAt: string;
};

export type VisitThreadRun = {
  taskRunId: string;
  previousTaskRunId: string | null;
  status: string;
  createdAt: string;
  messages: VisitThreadMessage[];
  sessionRestored: boolean | null;
};

/** `GET /pipeline-executions/{id}/visits/{visitId}/thread`. */
export type VisitThread = {
  visitId: string;
  nodeId: string;
  runs: VisitThreadRun[];
};

/** One row of `GET /projects/{id}/pipeline-definitions`. */
export type PipelineDefinitionSummary = {
  id: string;
  key: string;
  name: string;
  archivedAt: string | null;
};
