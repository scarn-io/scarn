import {
  parseUuidV7,
  type LaneContract,
  type NodeVisitContract,
  type PipelineExecutionContract,
  type PipelineVersionContract,
  type VisitTaskContract,
} from "@scarn/api/frontend-contracts";

/** Fixture builders shared by the run view's tests. */

const PROJECT_ID = "019e709b-574f-742c-8fda-00a1bcc71b9d";
const DEFINITION_ID = "019e9a92-b432-73e8-9341-3519156fa702";
const VERSION_ID = "019e9a92-b432-73e8-9341-3519156fa703";
const WORK_ITEM_ID = "019e9a92-b432-73e8-9341-3519156fa707";

export function buildVisitTask(
  overrides: Partial<Omit<VisitTaskContract, "taskId">> & { taskId: string },
): VisitTaskContract {
  const status = overrides.status ?? "succeeded";
  return {
    attemptNumber: 1,
    status,
    startedAt: status === "queued" ? null : "2026-06-05T12:00:05.000Z",
    completedAt: status === "succeeded" ? "2026-06-05T12:00:10.000Z" : null,
    workBranch: null,
    ...overrides,
    taskId: parseUuidV7(overrides.taskId),
  };
}

export function buildVisit(
  overrides: Partial<Omit<NodeVisitContract, "tasks" | "id">> & {
    id: string;
    nodeId: string;
    tasks?: VisitTaskContract[];
  },
): NodeVisitContract {
  return {
    nodeKind: "step",
    laneId: null,
    fromVisitId: null,
    fromLaneGroupId: null,
    transition: { kind: "start", index: 0 },
    routing: null,
    status: "succeeded",
    waitFor: null,
    actions: null,
    input: {},
    result: null,
    resultTaskId: null,
    error: null,
    tasks: [],
    questions: [],
    createdByUserId: null,
    resolvedByUserId: null,
    resolvedAt: null,
    conversationId: null,
    createdAt: "2026-06-05T12:00:00.000Z",
    completedAt: null,
    ...overrides,
    id: parseUuidV7(overrides.id),
  };
}

export function buildLane(
  overrides: Partial<Omit<LaneContract, "id" | "laneGroupId">> & {
    id: string;
    laneGroupId: string;
  },
): LaneContract {
  return {
    index: 0,
    item: null,
    route: { kind: "route", index: 0 },
    origin: "split",
    status: "active",
    arrivedAtNodeId: null,
    arrivalArgs: null,
    arrivedFromVisitId: null,
    arrivalTransition: null,
    mergedIntoVisitId: null,
    ...overrides,
    id: parseUuidV7(overrides.id),
    laneGroupId: parseUuidV7(overrides.laneGroupId),
  };
}

export function buildRunExecution(
  overrides: Partial<Omit<PipelineExecutionContract, "id">> & { id: string },
): PipelineExecutionContract {
  return {
    projectId: parseUuidV7(PROJECT_ID),
    workItemId: parseUuidV7(WORK_ITEM_ID),
    workItemTitle: "Checkout crashes when applying a coupon",
    pipelineDefinitionId: parseUuidV7(DEFINITION_ID),
    pipelineDefinitionVersionId: parseUuidV7(VERSION_ID),
    runStatus: "succeeded",
    status: "succeeded",
    waitingFor: null,
    endNodeId: null,
    error: null,
    triggeredByUserId: null,
    startedBy: { kind: "system" },
    cancelledByUserId: null,
    startedAt: "2026-06-05T12:00:00.000Z",
    completedAt: null,
    createdAt: "2026-06-05T12:00:00.000Z",
    updatedAt: "2026-06-05T12:00:10.000Z",
    visits: [],
    laneGroups: [],
    lanes: [],
    ...overrides,
    id: parseUuidV7(overrides.id),
  };
}

/** A version whose document is `review → approve (wait) → done`. */
export function buildRunVersion(): PipelineVersionContract {
  return {
    id: parseUuidV7(VERSION_ID),
    pipelineDefinitionId: parseUuidV7(DEFINITION_ID),
    version: 1,
    schemaVersion: 1,
    contentHash: "hash",
    definition: {
      schemaVersion: 1,
      key: "quality-gate-pipeline",
      start: { to: "review" },
      nodes: {
        review: {
          kind: "step",
          step: "review",
          title: "Review",
          next: {
            routes: [{ to: "approve" }],
          },
        },
        approve: {
          kind: "wait",
          for: "decision",
          actions: [
            { key: "approve", label: "Approve", body: "optional" },
            { key: "reject", label: "Reject", body: "optional" },
          ],
          next: {
            routes: [{ to: "done" }],
          },
        },
        done: { kind: "succeed" },
      },
    },
    steps: [],
    createdAt: "2026-06-05T12:00:00.000Z",
  };
}

export function buildTask({
  id,
  projectId,
  status = "succeeded",
  kind = "agent",
}: {
  id: string;
  projectId: string;
  status?: "queued" | "running" | "succeeded";
  kind?: "agent" | "code";
}) {
  return {
    id,
    taskId: "019e9a92-b432-73e8-9341-3519156fa709",
    number: 1,
    reason: "initial",
    projectId,
    workItemId: WORK_ITEM_ID,
    taskExecutionConfigId: "019e9a92-b432-73e8-9341-3519156fa708",
    name: "Triage",
    kind,
    previousTaskRunId: null,
    baseBranch: null,
    baseCommit: null,
    heartbeatSeconds: null,
    status,
    inputJson: null,
    claimedBy: null,
    claimedAt: null,
    lastHeartbeatAt: null,
    leaseExpiresAt: null,
    executionTimeoutSeconds: null,
    executionDeadlineAt: null,
    startedAt: status === "queued" ? null : "2026-06-05T12:00:05.000Z",
    completedAt: status === "succeeded" ? "2026-06-05T12:00:10.000Z" : null,
    resultJson: null,
    errorJson: null,
    sessionRestored: null,
    workBranch: null,
    createdFromBranch: null,
    createdAt: "2026-06-05T12:00:00.000Z",
    updatedAt: "2026-06-05T12:00:10.000Z",
  };
}
