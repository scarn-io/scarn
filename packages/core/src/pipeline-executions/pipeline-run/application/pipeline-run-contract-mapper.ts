import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import type { AnyJsonObject } from "@scarn/core/common/contracts/json";
import {
  toStartedBy,
  type StartedByContract,
} from "@scarn/core/common/contracts/started-by";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { UsernameReader } from "@scarn/core/organizations/organization/application/username-reader";
import type { AutomationRepo } from "@scarn/core/pipeline-definitions/automation/application/automation-repo";
import type { TaskRunRepo } from "@scarn/core/tasks/task-run/application/task-run-repo";
import type { TaskRunEntity } from "@scarn/core/tasks/task-run/domain/task-run-entity";
import type { WorkItemTitleReader } from "@scarn/core/work-items/work-item/application/work-item-title-reader";
import { parseWorkItemId } from "@scarn/core/work-items/work-item/domain/work-item-id";
import type { PipelineGraphVersionRepo } from "@scarn/core/pipeline-definitions/pipeline-graph/application/pipeline-graph-version-repo";
import type { PipelineDocument } from "@scarn/sdk/contracts/pipeline-document";
import type {
  DecisionActionContract,
  NodeVisitContract,
  PipelineExecutionContract,
  PipelineExecutionDisplayStatus,
  PipelineExecutionSummaryContract,
  WaitFor,
} from "../contracts/pipeline-run-contracts";
import type { VisitQuestion } from "../domain/engine/types";
import type { PipelineRunEntity } from "../domain/pipeline-run-entity";
import type { NodeVisitEntity } from "../domain/node-visit-entity";
import type { NodeVisitQuestionRepo } from "./node-visit-question-repo";
import type { PipelineRunHistory, PipelineRunRepo } from "./pipeline-run-repo";

export type PipelineRunReadDeps = {
  pipelineRunRepo: PipelineRunRepo;
  pipelineGraphVersionRepo: PipelineGraphVersionRepo;
  nodeVisitQuestionRepo: NodeVisitQuestionRepo;
  taskRunRepo: TaskRunRepo;
  workItemTitleReader: WorkItemTitleReader;
  usernameReader: UsernameReader;
  automationRepo: Pick<AutomationRepo, "loadMany">;
  timeProvider: TimeProvider;
  dbExecutor?: DbExecutor | undefined;
};

const iso = (value: Date | null | undefined): string | null =>
  value ? value.toISOString() : null;

const requiredIso = (value: Date | null | undefined): string =>
  (value ?? new Date(0)).toISOString();

/** The ids of the visit's runs in `number` order, latest last. */
const visitTaskIds = (history: PipelineRunHistory, visitId: string): string[] =>
  history.visitTasks
    .filter((link) => link.visitId === visitId)
    .sort((left, right) => left.attemptNumber - right.attemptNumber)
    .map((link) => link.taskId);

/**
 * What the API shows for a run. An `active` run is `running` when any open
 * step visit's latest Task is running (liveness overlay applied), else
 * `queued`.
 */
export const deriveDisplayStatus = (
  run: PipelineRunEntity,
  history: PipelineRunHistory,
  tasksById: ReadonlyMap<string, TaskRunEntity>,
): PipelineExecutionDisplayStatus => {
  if (run.status !== "active") {
    return run.status;
  }
  const running = history.visits.some((visit) => {
    if (visit.nodeKind !== "step" || !visit.isOpen) {
      return false;
    }
    const latest = visitTaskIds(history, visit.id).at(-1);
    return latest !== undefined && tasksById.get(latest)?.status === "running";
  });
  return running ? "running" : "queued";
};

/** What the wait node `nodeId` waits for; null when it isn't a decision or reply wait. */
const waitForOf = (
  document: PipelineDocument | null,
  nodeId: string,
): WaitFor | null => {
  const node = document?.nodes[nodeId];
  return node?.kind === "wait" &&
    (node.for === "decision" || node.for === "reply")
    ? node.for
    : null;
};

/** The actions of the decision wait `nodeId`, with `body` filled in; null for any other node. */
const decisionActionsOf = (
  document: PipelineDocument | null,
  nodeId: string,
): DecisionActionContract[] | null => {
  const node = document?.nodes[nodeId];
  return node?.kind === "wait" && node.for === "decision"
    ? (node.actions ?? []).map((action) => ({
        key: action.key,
        label: action.label,
        body: action.body ?? "optional",
      }))
    : null;
};

/**
 * `reply` when any waiting visit waits for one (a reply wait, or a step visit
 * whose agent handed the conversation to a person), else `decision`; null
 * unless the run is waiting.
 */
const deriveWaitingFor = ({
  run,
  history,
  document,
}: ProjectedRun): WaitFor | null => {
  if (run.status !== "waiting") {
    return null;
  }
  const waits = history.visits
    .filter((visit) => visit.status === "waiting")
    .map((visit) =>
      visit.nodeKind === "step" ? "reply" : waitForOf(document, visit.nodeId),
    );
  return waits.includes("reply")
    ? "reply"
    : waits.includes("decision")
      ? "decision"
      : null;
};

const visitToContract = (
  visit: NodeVisitEntity,
  { history, tasksById, document, questions }: ProjectedRun,
): NodeVisitContract => {
  const engine = visit.toEngineVisit();
  const tasks = visitTaskIds(history, visit.id).flatMap((taskId) => {
    const task = tasksById.get(taskId);
    const link = history.visitTasks.find(
      (entry) => entry.visitId === visit.id && entry.taskId === taskId,
    );
    return task && link
      ? [
          {
            taskId: task.id,
            attemptNumber: link.attemptNumber,
            status: task.status,
            startedAt: iso(task.startedAt),
            completedAt: iso(task.completedAt),
            workBranch: task.workBranch,
          },
        ]
      : [];
  });
  const result =
    visit.nodeKind === "step"
      ? visit.resultTaskId
        ? (tasksById.get(visit.resultTaskId)?.resultJson ?? null)
        : visit.result
      : engine.result;
  return {
    id: visit.id,
    nodeId: visit.nodeId,
    nodeKind: visit.nodeKind,
    laneId: visit.laneId,
    fromVisitId: visit.fromVisitId,
    fromLaneGroupId: visit.fromLaneGroupId,
    transition: visit.transition,
    routing: visit.routing as AnyJsonObject | null,
    status: visit.status,
    waitFor:
      visit.nodeKind === "wait" ? waitForOf(document, visit.nodeId) : null,
    actions:
      visit.nodeKind === "wait"
        ? decisionActionsOf(document, visit.nodeId)
        : null,
    input: visit.input,
    result,
    resultTaskId: engine.resultTaskId as UuidV7 | null,
    error: visit.error,
    tasks,
    questions: questions
      .filter((question) => question.visitId === visit.id)
      .map((question) => ({
        questionId: question.id as UuidV7,
        commentId: question.commentId as UuidV7,
        status: question.status,
      })),
    createdByUserId: visit.createdByUserId,
    resolvedByUserId: engine.resolvedByUserId as UuidV7 | null,
    resolvedAt: engine.resolvedAt,
    conversationId: visit.conversationId,
    createdAt: visit.createdAt.toISOString(),
    completedAt: iso(visit.completedAt),
  };
};

export type ProjectedRun = {
  run: PipelineRunEntity;
  history: PipelineRunHistory;
  tasksById: ReadonlyMap<string, TaskRunEntity>;
  workItemTitle: string;
  startedBy: StartedByContract;
  /** The run's pinned pipeline document; null if its version is gone. */
  document: PipelineDocument | null;
  questions: readonly VisitQuestion[];
};

const baseContract = (projected: ProjectedRun) => {
  const { run, history, tasksById, workItemTitle, startedBy } = projected;
  return {
    id: run.id,
    projectId: run.projectId,
    workItemId: run.workItemId,
    workItemTitle,
    pipelineDefinitionId: run.pipelineGraphId,
    pipelineDefinitionVersionId: run.pipelineGraphVersionId,
    runStatus: run.status,
    status: deriveDisplayStatus(run, history, tasksById),
    waitingFor: deriveWaitingFor(projected),
    endNodeId: run.endNodeId,
    error: run.errorJson as PipelineExecutionContract["error"],
    triggeredByUserId: run.triggeredByUserId,
    startedBy,
    cancelledByUserId: run.cancelledByUserId,
    startedAt: iso(run.startedAt),
    completedAt: iso(run.completedAt),
    createdAt: requiredIso(run.createdAt),
    updatedAt: requiredIso(run.updatedAt),
  };
};

/**
 * Loads the histories, Tasks, work-item titles, starters, pinned documents
 * and questions the read models need.
 */
export const loadProjectedRuns = async (
  runs: readonly PipelineRunEntity[],
  {
    pipelineRunRepo,
    pipelineGraphVersionRepo,
    nodeVisitQuestionRepo,
    taskRunRepo,
    workItemTitleReader,
    usernameReader,
    automationRepo,
    dbExecutor,
  }: PipelineRunReadDeps,
): Promise<ProjectedRun[]> => {
  if (runs.length === 0) {
    return [];
  }
  const runIds = runs.map((run) => run.id);
  const [histories, versions, questionsByRun] = await Promise.all([
    pipelineRunRepo.loadHistories(runIds, dbExecutor),
    pipelineGraphVersionRepo.loadMany(
      [...new Set(runs.map((run) => run.pipelineGraphVersionId))],
      dbExecutor,
    ),
    nodeVisitQuestionRepo.loadByRunIds(runIds, dbExecutor),
  ]);
  const documentsByVersionId = new Map<string, PipelineDocument>(
    versions.map((version) => [version.id, version.definitionJson]),
  );
  const taskIds = [...histories.values()].flatMap((history) =>
    history.visitTasks.map((link) => link.taskId as UuidV7),
  );
  const userIds = runs.flatMap((run) =>
    run.triggeredByUserId ? [run.triggeredByUserId] : [],
  );
  const automationIds = runs.flatMap((run) =>
    !run.triggeredByUserId && run.startedByAutomationId
      ? [run.startedByAutomationId]
      : [],
  );
  const [tasks, titles, usersById, automations] = await Promise.all([
    taskRunRepo.loadManyByIds([...new Set(taskIds)], dbExecutor),
    workItemTitleReader.loadTitlesByWorkItemIds(
      [...new Set(runs.map((run) => parseWorkItemId(run.workItemId)))],
      dbExecutor,
    ),
    usernameReader.loadUsernamesByUserId(userIds, dbExecutor),
    automationRepo.loadMany([...new Set(automationIds)], dbExecutor),
  ]);
  const tasksById = new Map<string, TaskRunEntity>(
    tasks.map((task) => [task.id, task]),
  );
  const automationsById = new Map(
    automations.map((automation) => [automation.id, automation]),
  );
  return runs.map((run) => ({
    run,
    history: histories.get(run.id) ?? {
      visits: [],
      laneGroups: [],
      lanes: [],
      visitTasks: [],
    },
    tasksById,
    workItemTitle: titles.get(parseWorkItemId(run.workItemId)) ?? "",
    startedBy: toStartedBy(
      run.triggeredByUserId,
      run.startedByAutomationId
        ? (automationsById.get(run.startedByAutomationId) ?? null)
        : null,
      usersById,
    ),
    document: documentsByVersionId.get(run.pipelineGraphVersionId) ?? null,
    questions: questionsByRun.get(run.id) ?? [],
  }));
};

export const projectedRunToContract = (
  projected: ProjectedRun,
): PipelineExecutionContract => ({
  ...baseContract(projected),
  visits: projected.history.visits.map((visit) =>
    visitToContract(visit, projected),
  ),
  laneGroups: projected.history.laneGroups.map((group) => ({
    id: group.id as UuidV7,
    parentLaneId: group.parentLaneId as UuidV7 | null,
    spawnedByVisitId: group.spawnedByVisitId as UuidV7,
    kind: group.kind,
    laneCount: group.laneCount,
    maxConcurrency: group.maxConcurrency,
    toleratedFailures: group.toleratedFailures,
    status: group.status,
  })),
  lanes: projected.history.lanes.map((lane) => ({
    id: lane.id as UuidV7,
    laneGroupId: lane.laneGroupId as UuidV7,
    index: lane.index,
    item: lane.item,
    route: lane.route,
    origin: lane.origin,
    status: lane.status,
    arrivedAtNodeId: lane.arrivedAtNodeId,
    arrivalArgs: lane.arrivalArgs,
    arrivedFromVisitId: lane.arrivedFromVisitId as UuidV7 | null,
    arrivalTransition: lane.arrivalTransition,
    mergedIntoVisitId: lane.mergedIntoVisitId as UuidV7 | null,
  })),
});

export const projectedRunToSummary = (
  projected: ProjectedRun,
): PipelineExecutionSummaryContract => ({
  ...baseContract(projected),
  openNodeIds: [
    ...new Set(
      projected.history.visits
        .filter((visit) => visit.isOpen)
        .map((visit) => visit.nodeId),
    ),
  ],
});

/** The full contract for each run, in input order. */
export const projectPipelineRunsToContracts = async (
  runs: readonly PipelineRunEntity[],
  deps: PipelineRunReadDeps,
): Promise<PipelineExecutionContract[]> =>
  (await loadProjectedRuns(runs, deps)).map(projectedRunToContract);
