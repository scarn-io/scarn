/** Public surface of the background worker's control API, for the CLI. */
export {
  CONTROL_API_PROTOCOL,
  DEFAULT_LOG_TAIL,
  controlErrorSchema,
  workerDiscoverySchema,
  workerHealthSchema,
  workerStatusSchema,
} from "./contracts/control-api";
export type {
  AcquireSlotsResponse,
  ControlError,
  ControlErrorCode,
  PutProjectBody,
  WorkerDiscovery,
  WorkerHealth,
  WorkerStatus,
} from "./contracts/control-api";
export {
  DEFAULT_SLOT_LEASE_TTL_MS,
  SlotLeaseManager,
  SlotLeaseNotFoundError,
} from "./application/slot-lease-manager";
export type {
  SlotLeaseGrant,
  SlotLeaseManagerOptions,
  SlotLeaseTimer,
} from "./application/slot-lease-manager";
export type {
  ControlApp,
  ControlAppDeps,
  ControlSupervisor,
  StopRequest,
} from "./infra/control-app";
export {
  CONTROL_SERVER_HOSTNAME,
  generateControlToken,
  startControlServer,
} from "./infra/control-server";
export type {
  ControlServer,
  StartControlServerOptions,
} from "./infra/control-server";
export { createControlClient } from "./infra/control-client";
export type {
  ControlClient,
  ControlClientOptions,
} from "./infra/control-client";
export {
  DEFAULT_DISCOVERY_HEALTH_TIMEOUT_MS,
  WorkerUnresponsiveError,
  findRunningWorker,
  isProcessAlive,
  readWorkerDiscovery,
  removeWorkerDiscovery,
  writeWorkerDiscovery,
} from "./infra/worker-discovery";
export type {
  FindRunningWorkerOptions,
  RunningWorker,
} from "./infra/worker-discovery";
export {
  DEFAULT_SLOT_HEARTBEAT_MS,
  RemoteSlotError,
  RemoteSlotPort,
} from "./infra/remote-slot-port";
export type { RemoteSlotPortOptions } from "./infra/remote-slot-port";
export {
  DEFAULT_LOG_MAX_BYTES,
  DEFAULT_LOG_MAX_FILES,
  RotatingLogDestination,
  rotatedLogFilePath,
} from "./infra/rotating-log-destination";
export type { RotatingLogDestinationOptions } from "./infra/rotating-log-destination";
export {
  createWorkerHostLogger,
  openWorkerStdioLog,
  workerStdioLogFilePath,
} from "./infra/worker-host-logger";
export type {
  CreateWorkerHostLoggerOptions,
  WorkerHostLogger,
} from "./infra/worker-host-logger";
export {
  DEFAULT_LOG_POLL_MS,
  followWorkerLog,
  matchesWorkerLogFilter,
  readWorkerLog,
} from "./infra/worker-log-reader";
export type {
  FollowWorkerLogOptions,
  WorkerLogFilter,
} from "./infra/worker-log-reader";
