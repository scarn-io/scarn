import type { AnyJsonValue } from "@scarn/core/common/contracts/json";
import { toStartedBy } from "@scarn/core/common/contracts/started-by";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { TaskSummaryReader } from "@scarn/core/tasks/task/application/task-summary-reader";
import { taskLatestOf } from "@scarn/core/tasks/task/application/task-summary-mapper";
import {
  loadProjectedRuns,
  projectedRunToSummary,
  type PipelineRunReadDeps,
  type ProjectedRun,
} from "../../pipeline-run/application/pipeline-run-contract-mapper";
import type { ProjectRunContract } from "../contracts/project-runs-contracts";
import {
  conversationTaskStatusLine,
  conversationTaskTitle,
  projectRunHref,
  scheduledTaskTitle,
  standaloneTaskOutcome,
  standaloneTaskTitle,
  standaloneTaskType,
  standaloneTaskWhatRan,
} from "./project-run-fields";
import {
  deriveProjectRunStatus,
  pipelineRunWaitingOn,
} from "./project-run-status";
import {
  pipelineRunOutcome,
  pipelineRunStatusLine,
  type ProjectRunVisitFacts,
} from "./project-run-status-line";
import type {
  ProjectRunKeyRecord,
  ProjectRunsReader,
} from "./project-runs-reader";

export type HydrateProjectRunsDeps = PipelineRunReadDeps & {
  projectRunsReader: ProjectRunsReader;
  taskSummaryReader: Pick<TaskSummaryReader, "loadByTaskIds">;
};

type Usernames = ReadonlyMap<UuidV7, { username: string | null }>;

/** A row before its people's usernames are read in one batch. */
type HydratedRun = Omit<ProjectRunContract, "waitingOn" | "startedBy"> & {
  waitingOnUserIds: UuidV7[];
  starterUserId: UuidV7 | null;
  startedBy: (
    usernames: Usernames,
    starterUserId: UuidV7 | null,
  ) => ProjectRunContract["startedBy"];
};

const visitFacts = (
  projected: ProjectedRun,
  questionBodies: ReadonlyMap<UuidV7, string>,
): ProjectRunVisitFacts[] =>
  projected.history.visits.map((visit) => {
    const latestTaskId = projected.history.visitTasks
      .filter((link) => link.visitId === visit.id)
      .sort((left, right) => left.attemptNumber - right.attemptNumber)
      .at(-1)?.taskId;
    return {
      nodeId: visit.nodeId,
      nodeKind: visit.nodeKind,
      status: visit.status,
      error: visit.error
        ? { name: visit.error.name, message: visit.error.message }
        : null,
      taskRunning:
        latestTaskId !== undefined &&
        projected.tasksById.get(latestTaskId)?.status === "running",
      openQuestionBody: questionBodies.get(visit.id) ?? null,
    };
  });

const runError = (
  errorJson: AnyJsonValue | null,
): { name: string; message: string } | null => {
  if (
    typeof errorJson !== "object" ||
    errorJson === null ||
    Array.isArray(errorJson)
  ) {
    return null;
  }
  const { name, message } = errorJson;
  return {
    name: typeof name === "string" ? name : "",
    message: typeof message === "string" ? message : "",
  };
};

const hydratePipelineRuns = async (
  keys: readonly ProjectRunKeyRecord[],
  viewerUserId: UuidV7 | null,
  deps: HydrateProjectRunsDeps,
): Promise<Map<UuidV7, HydratedRun>> => {
  if (keys.length === 0) {
    return new Map();
  }
  const runIds = keys.map((key) => key.id);
  const [runs, questionBodies] = await Promise.all([
    deps.pipelineRunRepo.loadMany(runIds, deps.dbExecutor),
    deps.projectRunsReader.loadOpenQuestionBodies(runIds, deps.dbExecutor),
  ]);
  const keysById = new Map(keys.map((key) => [key.id, key]));
  const projected = await loadProjectedRuns(runs, deps);
  return new Map(
    projected.flatMap((run) => {
      const key = keysById.get(run.run.id);
      if (!key) {
        return [];
      }
      const summary = projectedRunToSummary(run);
      const waiting = pipelineRunWaitingOn({
        waitingFor: summary.waitingFor,
        waiterUserIds: key.runWaiterUserIds,
        viewerUserId,
      });
      const status = deriveProjectRunStatus({
        type: "pipeline",
        status: summary.status,
        waitingFor: summary.waitingFor,
        endNodeId: summary.endNodeId,
        waitingOnYou: waiting.waitingOnYou,
      });
      const lineFacts = {
        status,
        visits: visitFacts(run, questionBodies),
        document: run.document,
        endNodeId: summary.endNodeId,
        error: runError(run.run.errorJson),
      };
      const hydrated: HydratedRun = {
        type: "pipeline",
        id: summary.id,
        href: projectRunHref("pipeline", summary.id),
        title: summary.workItemTitle,
        whatRan: {
          kind: "pipeline",
          id: summary.pipelineDefinitionId,
          name: key.whatRanName,
        },
        workItem: key.workItem,
        status,
        statusLine: pipelineRunStatusLine(lineFacts),
        outcome: pipelineRunOutcome(lineFacts),
        openNodeIds: summary.openNodeIds,
        waitingOnYou: waiting.waitingOnYou,
        waitingOnUserIds: waiting.waitingOnUserIds,
        starterUserId: null,
        startedBy: () => summary.startedBy,
        createdAt: summary.createdAt,
        updatedAt: summary.updatedAt,
      };
      return [[summary.id, hydrated] as const];
    }),
  );
};

const hydrateTasks = async (
  keys: readonly ProjectRunKeyRecord[],
  viewerUserId: UuidV7 | null,
  deps: HydrateProjectRunsDeps,
): Promise<Map<UuidV7, HydratedRun>> => {
  if (keys.length === 0) {
    return new Map();
  }
  const taskIds = keys.map((key) => key.id);
  const keysById = new Map(keys.map((key) => [key.id, key]));
  const [records, latestRuns, conversations] = await Promise.all([
    deps.taskSummaryReader.loadByTaskIds(taskIds, deps.dbExecutor),
    deps.projectRunsReader.loadLatestTaskRuns(taskIds, deps.dbExecutor),
    deps.projectRunsReader.loadTaskConversations(taskIds, deps.dbExecutor),
  ]);
  return new Map(
    records.flatMap((record) => {
      const key = keysById.get(record.id);
      if (!key) {
        return [];
      }
      const conversation =
        record.workItem === null ? conversations.get(record.id) : undefined;
      const status = deriveProjectRunStatus({
        type: "task",
        status: record.status,
        waitingOnYou:
          viewerUserId !== null &&
          record.waitingOnUserIds.includes(viewerUserId),
        conversationClosed: conversation?.status === "closed",
      });
      const waitingOnUserIds =
        status === "needs-you" || status === "waiting"
          ? record.waitingOnUserIds
          : [];
      const waitingOnYou = status === "needs-you";
      const type = standaloneTaskType(record);
      const hydrated: HydratedRun = {
        type,
        id: record.id,
        href: projectRunHref(type, record.id),
        title: conversation
          ? conversationTaskTitle(conversation.firstPersonMessage)
          : standaloneTaskTitle({
              stepDefinition: record.stepDefinition,
              prompt: record.prompt,
              workItemTitle:
                record.workItem?.title ??
                scheduledTaskTitle(
                  record.startedByAutomation,
                  record.startedBySchedule,
                ),
            }),
        whatRan: standaloneTaskWhatRan(record),
        workItem: key.workItem,
        status,
        statusLine: conversation
          ? conversationTaskStatusLine(conversation.lastAgentMessage)
          : (taskLatestOf(record)?.text ?? ""),
        outcome: standaloneTaskOutcome({
          status: record.status,
          latestRun: latestRuns.get(record.id) ?? null,
        }),
        openNodeIds: [],
        waitingOnYou,
        waitingOnUserIds,
        starterUserId: record.startedByUserId,
        startedBy: (usernames, starterUserId) =>
          toStartedBy(
            {
              userId: starterUserId,
              automation: record.startedByAutomation,
              schedule: record.startedBySchedule,
            },
            usernames,
          ),
        createdAt: record.createdAt.toISOString(),
        updatedAt: conversation
          ? new Date(key.updatedAt).toISOString()
          : record.updatedAt.toISOString(),
      };
      return [[record.id, hydrated] as const];
    }),
  );
};

/**
 * Builds each page row from its kind's facts with the same derivations the
 * detail views use, in page order. Rows deleted since the page was read are
 * dropped.
 */
export const hydrateProjectRuns = async (
  keys: readonly ProjectRunKeyRecord[],
  viewerUserId: UuidV7 | null,
  deps: HydrateProjectRunsDeps,
): Promise<ProjectRunContract[]> => {
  const ofType = (...types: ProjectRunKeyRecord["type"][]) =>
    keys.filter((key) => types.includes(key.type));
  const [pipelines, standalone] = await Promise.all([
    hydratePipelineRuns(ofType("pipeline"), viewerUserId, deps),
    hydrateTasks(ofType("step", "task"), viewerUserId, deps),
  ]);
  const rows = keys.flatMap((key) => {
    const row = (key.type === "pipeline" ? pipelines : standalone).get(key.id);
    return row ? [row] : [];
  });
  const usernames = await deps.usernameReader.loadUsernamesByUserId(
    [
      ...new Set(
        rows.flatMap((row) =>
          row.starterUserId === null
            ? row.waitingOnUserIds
            : [row.starterUserId, ...row.waitingOnUserIds],
        ),
      ),
    ],
    deps.dbExecutor,
  );
  return rows.map(({ waitingOnUserIds, starterUserId, startedBy, ...row }) => ({
    ...row,
    waitingOn: waitingOnUserIds.map((userId) => ({
      userId,
      username: usernames.get(userId)?.username ?? null,
    })),
    startedBy: startedBy(usernames, starterUserId),
  }));
};
