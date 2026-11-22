import type { TaskContract } from "../contracts/task-contracts";
import type { TaskEntity } from "../domain/task-entity";

export const taskEntityToContract = (task: TaskEntity): TaskContract => ({
  id: task.id,
  projectId: task.projectId,
  workItemId: task.workItemId,
  stepDefinitionId: task.stepDefinitionId,
  kind: task.kind,
  name: task.name,
  taskExecutionConfigId: task.taskExecutionConfigId,
  environmentSelection: task.environmentSelection,
  inputJson: task.inputJson,
  retryJson: task.retryJson,
  grants: [...task.grants],
  maxTurns: task.maxTurns,
  heartbeatSeconds: task.heartbeatSeconds,
  executionTimeoutSeconds: task.executionTimeoutSeconds,
  status: task.status,
  resultJson: task.resultJson,
  errorJson: task.errorJson,
  startedByUserId: task.startedByUserId,
  previousTaskId: task.previousTaskId,
  createdAt: task.createdAt.toISOString(),
  updatedAt: task.updatedAt.toISOString(),
});
