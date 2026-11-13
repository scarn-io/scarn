import type {
  TaskDetail,
  TaskRunArtifact,
  TaskRunDetail,
  TaskSummary,
} from "../src/lib/task-api-types";

export const PROJECT_ID = "0196a000-0000-7000-8000-000000000001";
export const WORK_ITEM_ID = "0196a000-0000-7000-8000-0000000000aa";
export const TASK_ID = "0196a000-0000-7000-8000-0000000000c1";
export const PREVIOUS_TASK_ID = "0196a000-0000-7000-8000-0000000000c0";
export const TASK_RUN_ID = "0196a000-0000-7000-8000-0000000000e1";
export const PIPELINE_RUN_ID = "0196a000-0000-7000-8000-0000000000bb";

const workItem = {
  id: WORK_ITEM_ID,
  platformKey: "acme/app#7",
  title: "Fix login",
};

export function makeTaskSummary(
  overrides: Partial<TaskSummary> = {},
): TaskSummary {
  return {
    id: TASK_ID,
    kind: "agent",
    name: "Investigate",
    status: "failed",
    createdAt: "2026-01-02T00:00:00.000Z",
    runNumber: 2,
    durationMs: 95_000,
    latest: { kind: "error", text: "Agent crashed\nstack…" },
    workItem,
    source: {
      kind: "step_definition",
      stepDefinitionId: "0196a000-0000-7000-8000-0000000000d1",
      key: "investigate",
      name: "Investigate",
      version: 3,
    },
    pipelineRunId: PIPELINE_RUN_ID,
    nodeId: "investigate",
    ...overrides,
  };
}

export function makeTaskDetail(
  overrides: Partial<TaskDetail> = {},
): TaskDetail {
  return {
    id: TASK_ID,
    projectId: PROJECT_ID,
    workItemId: WORK_ITEM_ID,
    kind: "agent",
    name: "Investigate",
    taskExecutionConfigId: null,
    inputJson: { question: "why?" },
    maxTurns: 20,
    status: "failed",
    resultJson: null,
    errorJson: { name: "AgentError", message: "Agent crashed" },
    previousTaskId: null,
    createdAt: "2026-01-02T00:00:00.000Z",
    updatedAt: "2026-01-02T00:05:00.000Z",
    workItem,
    source: {
      kind: "step_definition",
      stepDefinitionId: "0196a000-0000-7000-8000-0000000000d1",
      key: "investigate",
      name: "Investigate",
      version: 3,
    },
    pipelineRunId: PIPELINE_RUN_ID,
    nodeId: "investigate",
    startedBy: null,
    waitingOn: [],
    conversationId: null,
    ...overrides,
  };
}

export function makeTaskRun(
  overrides: Partial<TaskRunDetail> = {},
): TaskRunDetail {
  return {
    id: TASK_RUN_ID,
    taskId: TASK_ID,
    number: 1,
    reason: "initial",
    workItemId: WORK_ITEM_ID,
    name: "Investigate",
    kind: "agent",
    previousTaskRunId: null,
    baseBranch: "main",
    baseCommit: null,
    heartbeatSeconds: 30,
    status: "failed",
    claimedBy: "worker-laptop-1",
    claimedAt: "2026-01-02T00:00:01.000Z",
    lastHeartbeatAt: "2026-01-02T00:01:00.000Z",
    leaseExpiresAt: "2026-01-02T00:01:30.000Z",
    executionTimeoutSeconds: null,
    executionDeadlineAt: null,
    startedAt: "2026-01-02T00:00:02.000Z",
    completedAt: "2026-01-02T00:01:10.000Z",
    resultJson: null,
    errorJson: { name: "AgentError", message: "Agent crashed" },
    workBranch: "scarn/fix-login",
    createdFromBranch: "main",
    sessionRestored: null,
    createdAt: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

export function makeArtifact(
  overrides: Partial<TaskRunArtifact> = {},
): TaskRunArtifact {
  return {
    id: "0196a000-0000-7000-8000-0000000000f1",
    relativeStorePath: "report.md",
    sizeBytes: 2048,
    contentType: "text/markdown",
    kind: "generic",
    createdAt: "2026-01-02T00:01:05.000Z",
    ...overrides,
  };
}
