import type { TaskRunContract } from "../contracts/task-run-contracts";
import type { TaskRunEntity } from "../domain/task-run-entity";

const requiredIsoString = (value: Date | null | undefined): string =>
  value?.toISOString() ?? new Date(0).toISOString();

export const taskRunEntityToContract = (
  task: TaskRunEntity,
): TaskRunContract => ({
  id: task.id,
  taskId: task.taskId,
  number: task.number,
  reason: task.reason,
  projectId: task.projectId,
  workItemId: task.workItemId,
  taskExecutionConfigId: task.taskExecutionConfigId,
  name: task.name,
  kind: task.kind,
  previousTaskRunId: task.previousTaskRunId,
  baseBranch: task.baseBranch,
  baseCommit: task.baseCommit,
  heartbeatSeconds: task.heartbeatSeconds,
  status: task.status,
  inputJson: task.inputJson,
  claimedBy: task.claimedBy,
  claimedAt: task.claimedAt?.toISOString() ?? null,
  lastHeartbeatAt: task.lastHeartbeatAt?.toISOString() ?? null,
  leaseExpiresAt: task.leaseExpiresAt?.toISOString() ?? null,
  executionTimeoutSeconds: task.executionTimeoutSeconds,
  executionDeadlineAt: task.executionDeadlineAt?.toISOString() ?? null,
  startedAt: task.startedAt?.toISOString() ?? null,
  completedAt: task.completedAt?.toISOString() ?? null,
  resultJson: task.resultJson,
  errorJson: task.errorJson,
  workBranch: task.workBranch,
  createdFromBranch: task.createdFromBranch,
  sessionRestored: task.sessionRestored,
  createdAt: requiredIsoString(task.createdAt),
  updatedAt: requiredIsoString(task.updatedAt),
});
