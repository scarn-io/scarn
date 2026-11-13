/**
 * Request and response shapes of the background worker's local control API,
 * shared by the server (`infra/control-app.ts`) and the CLI's Eden client.
 *
 * {@link CONTROL_API_PROTOCOL} is bumped on every change to these shapes or
 * the routes; the CLI refuses a worker whose protocol or version differs
 * from its own.
 */
import { z } from "zod";

export const CONTROL_API_PROTOCOL = 1;

const nonNegativeIntSchema = z.number().int().nonnegative();
const queryIntSchema = z.coerce.number().int().nonnegative();
const queryBoolSchema = z
  .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
  .transform((value) => value === true || value === "true" || value === "1");

export const controlErrorCodeSchema = z.enum([
  "bad_request",
  "unauthorized",
  "forbidden",
  "not_found",
  "worker_not_running",
  "base_url_mismatch",
  "lease_not_found",
  "internal",
]);
export type ControlErrorCode = z.infer<typeof controlErrorCodeSchema>;

export const controlErrorSchema = z.object({
  code: controlErrorCodeSchema,
  message: z.string(),
});
export type ControlError = z.infer<typeof controlErrorSchema>;

export const workerSupervisorStateSchema = z.enum([
  "starting",
  "running",
  "draining",
  "stopping",
  "stopped",
]);

export const workerHealthSchema = z.object({
  instance: z.string(),
  version: z.string(),
  protocol: z.number().int(),
  pid: z.number().int(),
  startedAt: z.string(),
  state: workerSupervisorStateSchema,
});
export type WorkerHealth = z.infer<typeof workerHealthSchema>;

/** The contents of `~/.scarn/workers/<instance>/worker.json`. */
export const workerDiscoverySchema = z.object({
  pid: z.number().int(),
  port: z.number().int().positive(),
  token: z.string().min(1),
  version: z.string(),
  protocol: z.number().int(),
  instance: z.string(),
  baseUrl: z.string().nullable(),
  startedAt: z.string(),
});
export type WorkerDiscovery = z.infer<typeof workerDiscoverySchema>;

export const workerProjectSettingsSchema = z.object({
  instance: z.string(),
  projectId: z.string(),
  projectRef: z.string(),
  repoDir: z.string(),
  sourceBranch: z.string(),
  baseUrl: z.string(),
  addedByUserId: z.string(),
  concurrency: nonNegativeIntSchema.nullable(),
  workItemId: z.string().nullable(),
  preserveRuntime: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const projectWorkerStatusSchema = z.object({
  projectId: z.string(),
  projectRef: z.string(),
  state: z.enum(["starting", "running", "draining", "stopped", "error"]),
  errorReason: z
    .enum([
      "repo_missing",
      "project_unavailable",
      "auth_missing",
      "auth_rejected",
      "user_changed",
      "crashed",
    ])
    .nullable(),
  errorMessage: z.string().nullable(),
  nextRetryAt: z.string().nullable(),
  settings: workerProjectSettingsSchema,
  activeRuns: z.number().int(),
});

export const activeRunStatusSchema = z.object({
  taskRunId: z.string(),
  projectId: z.string(),
  taskName: z.string().nullable(),
  phase: z.enum(["launching", "running", "tearing_down"]),
  startedAt: z.string(),
});

export const recentRunSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  taskRunId: z.string(),
  status: z.enum(["launching", "running", "succeeded", "failed"]),
  workspacePath: z.string().nullable(),
  runtimeContainerId: z.string().nullable(),
  agentBaseUrl: z.string().nullable(),
  opencodeSessionId: z.string().nullable(),
  failureReason: z.string().nullable(),
  metadataJson: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().nullable(),
});

export const slotSnapshotSchema = z.object({
  machineLimit: z.number().int(),
  machineInUse: z.number().int(),
  projects: z.array(
    z.object({
      projectId: z.string(),
      limit: z.number().int().nullable(),
      inUse: z.number().int(),
    }),
  ),
});

export const workerStatusQuerySchema = z.object({
  recentRuns: queryIntSchema.max(500).optional(),
});

export const DEFAULT_STATUS_RECENT_RUNS = 20;

export const workerStatusSchema = z.object({
  instance: z.string(),
  baseUrl: z.string().nullable(),
  state: workerSupervisorStateSchema,
  maxConcurrency: z.number().int(),
  slots: slotSnapshotSchema,
  projects: z.array(projectWorkerStatusSchema),
  activeRuns: z.array(activeRunStatusSchema),
  recentRuns: z.array(recentRunSchema),
});
export type WorkerStatus = z.infer<typeof workerStatusSchema>;

export const projectParamsSchema = z.object({ projectId: z.string().min(1) });

export const putProjectBodySchema = z.object({
  projectRef: z.string().min(1),
  repoDir: z.string().min(1),
  sourceBranch: z.string().min(1),
  baseUrl: z.string().min(1),
  addedByUserId: z.string().min(1),
  concurrency: nonNegativeIntSchema.nullable(),
  workItemId: z.string().min(1).nullable(),
  preserveRuntime: z.boolean(),
});
export type PutProjectBody = z.infer<typeof putProjectBodySchema>;

export const putProjectResponseSchema = z.object({
  outcome: z.enum(["added", "updated", "restarting", "removed"]),
  project: projectWorkerStatusSchema.nullable(),
});

export const deleteProjectResponseSchema = z.object({
  removed: z.boolean(),
  drainingRuns: z.array(activeRunStatusSchema),
});

export const patchConfigBodySchema = z.object({
  maxConcurrency: nonNegativeIntSchema,
});
export const patchConfigResponseSchema = patchConfigBodySchema;

export const runParamsSchema = z.object({ taskRunId: z.string().min(1) });
export const abortRunResponseSchema = z.object({ found: z.boolean() });

export const stopBodySchema = z.object({ force: z.boolean().default(false) });
export const stopResponseSchema = z.object({
  state: workerSupervisorStateSchema,
});

/**
 * A borrower's slots. The first acquire (without `leaseId`) opens a lease;
 * later acquires pass it to add to the same lease. A lease expires, and its
 * slots go back, when no acquire or heartbeat renews it in time.
 */
export const acquireSlotsBodySchema = z.object({
  leaseId: z.string().min(1).optional(),
  projectId: z.string().min(1),
  wanted: nonNegativeIntSchema,
});
export const acquireSlotsResponseSchema = z.object({
  leaseId: z.string(),
  granted: z.number().int(),
  expiresAt: z.string(),
  /** Pass to `POST /slots/changed` as `since`, so no change is missed. */
  generation: z.number().int(),
});
export type AcquireSlotsResponse = z.infer<typeof acquireSlotsResponseSchema>;

export const releaseSlotsBodySchema = z.object({
  leaseId: z.string().min(1),
  projectId: z.string().min(1),
  count: nonNegativeIntSchema,
});
export const releaseSlotsResponseSchema = z.object({
  expiresAt: z.string(),
});

export const leaseParamsSchema = z.object({ leaseId: z.string().min(1) });
export const heartbeatResponseSchema = z.object({ expiresAt: z.string() });

export const MAX_SLOTS_CHANGED_WAIT_MS = 30_000;

/** Long-polls until slots change after generation `since`, or `waitMs`. */
export const slotsChangedBodySchema = z.object({
  since: z.number().int().nonnegative(),
  waitMs: nonNegativeIntSchema.max(MAX_SLOTS_CHANGED_WAIT_MS),
});
export const slotsChangedResponseSchema = z.object({
  changed: z.boolean(),
  generation: z.number().int(),
});

export const DEFAULT_LOG_TAIL = 200;

export const logsQuerySchema = z.object({
  project: z.string().min(1).optional(),
  run: z.string().min(1).optional(),
  tail: queryIntSchema.max(10_000).optional(),
  follow: queryBoolSchema.optional(),
});
