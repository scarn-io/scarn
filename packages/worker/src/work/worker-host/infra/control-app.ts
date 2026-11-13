/**
 * Routes of the background worker's local control API. Request guarding
 * (token, `Origin`, `Host`) happens in `control-server.ts` before a request
 * reaches these routes. The CLI shares {@link ControlApp} through its Eden
 * treaty client.
 */
import { Elysia, sse } from "elysia";
import type { WorkerSupervisor } from "../application/worker-supervisor";
import {
  SlotLeaseNotFoundError,
  type SlotLeaseManager,
} from "../application/slot-lease-manager";
import {
  abortRunResponseSchema,
  acquireSlotsBodySchema,
  acquireSlotsResponseSchema,
  CONTROL_API_PROTOCOL,
  controlErrorSchema,
  DEFAULT_LOG_TAIL,
  DEFAULT_STATUS_RECENT_RUNS,
  deleteProjectResponseSchema,
  heartbeatResponseSchema,
  leaseParamsSchema,
  logsQuerySchema,
  patchConfigBodySchema,
  patchConfigResponseSchema,
  projectParamsSchema,
  putProjectBodySchema,
  putProjectResponseSchema,
  releaseSlotsBodySchema,
  releaseSlotsResponseSchema,
  runParamsSchema,
  slotsChangedBodySchema,
  slotsChangedResponseSchema,
  stopBodySchema,
  stopResponseSchema,
  workerHealthSchema,
  workerStatusQuerySchema,
  workerStatusSchema,
  type ControlError,
} from "../contracts/control-api";
import {
  WorkerBaseUrlMismatchError,
  WorkerNotRunningError,
} from "../domain/worker-supervisor-errors";
import { followWorkerLog, readWorkerLog } from "./worker-log-reader";

/** The supervisor operations the control API calls. */
export type ControlSupervisor = Pick<
  WorkerSupervisor,
  | "state"
  | "instance"
  | "addOrUpdateProject"
  | "removeProject"
  | "setMachineLimit"
  | "cancelRun"
  | "stop"
  | "status"
>;

/** A stop asked for over `POST /stop`; `done` settles once the worker stopped. */
export type StopRequest = { force: boolean; done: Promise<void> };

export type ControlAppDeps = {
  supervisor: ControlSupervisor;
  leases: SlotLeaseManager;
  version: string;
  pid: number;
  startedAt: string;
  logFilePath: string;
  onStopRequested?: ((request: StopRequest) => void) | undefined;
  logPollMs?: number | undefined;
};

const errorResponses = {
  400: controlErrorSchema,
  404: controlErrorSchema,
  409: controlErrorSchema,
  500: controlErrorSchema,
};

function controlError(
  status: number,
  code: ControlError["code"],
  message: string,
): Response {
  return Response.json({ code, message } satisfies ControlError, { status });
}

// eslint-disable-next-line local/no-unknown-parameter-type -- Elysia hands onError whatever was thrown
function mapError(code: string | number, error: unknown): Response {
  if (error instanceof WorkerNotRunningError) {
    return controlError(409, "worker_not_running", error.message);
  }
  if (error instanceof WorkerBaseUrlMismatchError) {
    return controlError(409, "base_url_mismatch", error.message);
  }
  if (error instanceof SlotLeaseNotFoundError) {
    return controlError(404, "lease_not_found", error.message);
  }
  if (
    error instanceof RangeError ||
    code === "VALIDATION" ||
    code === "PARSE"
  ) {
    return controlError(400, "bad_request", messageOf(error));
  }
  if (code === "NOT_FOUND") {
    return controlError(404, "not_found", "No such route.");
  }
  return controlError(500, "internal", messageOf(error));
}

// eslint-disable-next-line local/no-unknown-parameter-type -- a thrown value is untyped
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createControlApp(deps: ControlAppDeps) {
  const { supervisor, leases } = deps;
  return new Elysia()
    .onError(({ code, error }) => mapError(code, error))
    .get(
      "/health",
      () => ({
        instance: supervisor.instance,
        version: deps.version,
        protocol: CONTROL_API_PROTOCOL,
        pid: deps.pid,
        startedAt: deps.startedAt,
        state: supervisor.state,
      }),
      { response: { 200: workerHealthSchema } },
    )
    .get(
      "/status",
      ({ query }) =>
        supervisor.status({
          recentRuns: query.recentRuns ?? DEFAULT_STATUS_RECENT_RUNS,
        }),
      {
        query: workerStatusQuerySchema,
        response: { 200: workerStatusSchema, ...errorResponses },
      },
    )
    .put(
      "/projects/:projectId",
      ({ params, body }) =>
        supervisor.addOrUpdateProject({ ...body, projectId: params.projectId }),
      {
        params: projectParamsSchema,
        body: putProjectBodySchema,
        response: { 200: putProjectResponseSchema, ...errorResponses },
      },
    )
    .delete(
      "/projects/:projectId",
      ({ params }) => supervisor.removeProject(params.projectId),
      {
        params: projectParamsSchema,
        response: { 200: deleteProjectResponseSchema, ...errorResponses },
      },
    )
    .patch(
      "/config",
      ({ body }) => supervisor.setMachineLimit(body.maxConcurrency),
      {
        body: patchConfigBodySchema,
        response: { 200: patchConfigResponseSchema, ...errorResponses },
      },
    )
    .post(
      "/runs/:taskRunId/abort",
      ({ params }) => supervisor.cancelRun(params.taskRunId),
      {
        params: runParamsSchema,
        response: { 200: abortRunResponseSchema, ...errorResponses },
      },
    )
    .post(
      "/stop",
      ({ body }) => {
        const done = supervisor.stop({ force: body.force });
        void done.catch(() => undefined);
        deps.onStopRequested?.({ force: body.force, done });
        return { state: supervisor.state };
      },
      {
        body: stopBodySchema,
        response: { 200: stopResponseSchema, ...errorResponses },
      },
    )
    .post("/slots/acquire", ({ body }) => leases.acquire(body), {
      body: acquireSlotsBodySchema,
      response: { 200: acquireSlotsResponseSchema, ...errorResponses },
    })
    .post("/slots/release", ({ body }) => leases.release(body), {
      body: releaseSlotsBodySchema,
      response: { 200: releaseSlotsResponseSchema, ...errorResponses },
    })
    .post(
      "/slots/:leaseId/heartbeat",
      ({ params }) => leases.heartbeat(params.leaseId),
      {
        params: leaseParamsSchema,
        response: { 200: heartbeatResponseSchema, ...errorResponses },
      },
    )
    .post(
      "/slots/changed",
      ({ body, request }) =>
        leases.waitForChange(body.since, body.waitMs, request.signal),
      {
        body: slotsChangedBodySchema,
        response: { 200: slotsChangedResponseSchema, ...errorResponses },
      },
    )
    .get(
      "/logs",
      async ({ query, request }) => {
        const filter = { projectId: query.project, taskRunId: query.run };
        const { lines, offset } = await readWorkerLog({
          ...filter,
          filePath: deps.logFilePath,
          tail: query.tail ?? DEFAULT_LOG_TAIL,
        });
        if (!query.follow) return { lines };
        return streamLogLines(
          lines,
          followWorkerLog({
            ...filter,
            filePath: deps.logFilePath,
            from: offset,
            signal: request.signal,
            pollMs: deps.logPollMs,
          }),
        );
      },
      { query: logsQuerySchema },
    );
}

/** Each log line is one `line` server-sent event whose data is the raw line. */
async function* streamLogLines(
  existing: readonly string[],
  appended: AsyncIterable<string>,
) {
  for (const line of existing) yield sse({ event: "line", data: line });
  for await (const line of appended) yield sse({ event: "line", data: line });
}

export type ControlApp = ReturnType<typeof createControlApp>;
