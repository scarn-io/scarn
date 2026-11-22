/**
 * The engine's working copy of a run. Every command `decide` emits is also
 * applied here, so later decisions in the same call see earlier writes.
 */
import type {
  PipelineDocument,
  PipelineNode,
} from "@scarn/sdk/contracts/pipeline-document";
import {
  analyzeSplits,
  buildGraph,
  type SplitAnalysis,
} from "@scarn/shared-core/pipelines";
import type { TaskRunStatus } from "@scarn/core/tasks/task-run/domain/task-run-entity";
import type {
  Command,
  DecideOptions,
  Lane,
  LaneGroup,
  RunInfo,
  RunState,
  TaskInfo,
  Visit,
  VisitQuestion,
  VisitTask,
} from "./types";

export interface EngineContext {
  document: PipelineDocument;
  /** The document's splits and merges, analysed once per `decide` call. */
  splits: SplitAnalysis;
  run: RunInfo;
  visits: Visit[];
  groups: LaneGroup[];
  lanes: Lane[];
  visitTasks: VisitTask[];
  tasks: Map<string, TaskInfo>;
  questions: VisitQuestion[];
  workItem: RunState["workItem"];
  options: DecideOptions;
  commands: Command[];
}

export function createContext(
  document: PipelineDocument,
  state: RunState,
  options: DecideOptions,
): EngineContext {
  const copy = structuredClone(state);
  return {
    document,
    splits: analyzeSplits(buildGraph(document)),
    run: copy.run,
    visits: copy.visits,
    groups: copy.laneGroups,
    lanes: copy.lanes,
    visitTasks: copy.visitTasks,
    tasks: new Map(copy.tasks.map((task) => [task.id, task])),
    questions: copy.questions,
    workItem: copy.workItem,
    options,
    commands: [],
  };
}

function apply(ctx: EngineContext, command: Command): void {
  switch (command.type) {
    case "createVisit":
      ctx.visits.push(structuredClone(command.visit));
      return;
    case "updateVisit":
      Object.assign(visitById(ctx, command.visitId), command.patch);
      return;
    case "createLaneGroup":
      ctx.groups.push(structuredClone(command.group));
      ctx.lanes.push(...structuredClone(command.lanes));
      return;
    case "updateLaneGroup":
      Object.assign(groupById(ctx, command.groupId), command.patch);
      return;
    case "createLane":
      ctx.lanes.push(structuredClone(command.lane));
      return;
    case "updateLane":
      Object.assign(
        laneById(ctx, command.laneId),
        structuredClone(command.patch),
      );
      return;
    case "queueTask":
      visitById(ctx, command.task.visitId).taskId = command.task.taskId;
      ctx.visitTasks.push({
        visitId: command.task.visitId,
        attemptNumber: command.task.attemptNumber,
        taskId: command.task.id,
      });
      ctx.tasks.set(command.task.id, {
        id: command.task.id,
        status: "queued",
        result: null,
        error: null,
        workBranch: null,
      });
      return;
    case "cancelTask": {
      const task = ctx.tasks.get(command.taskId);
      if (task !== undefined) {
        task.status = "cancelled";
      }
      return;
    }
    case "askQuestion":
      ctx.questions.push({
        id: command.questionId,
        visitId: command.visitId,
        commentId: command.commentId,
        status: "open",
        answerCommentId: null,
        answeredByUserId: null,
        createdAt: ctx.options.now,
        resolvedAt: null,
      });
      return;
    case "updateQuestion":
      Object.assign(questionById(ctx, command.questionId), command.patch);
      return;
    case "updateRun":
      Object.assign(ctx.run, command.patch);
      return;
  }
}

/** Applies commands to a copy of a run state, as the transactional layer would to the tables. */
export function applyCommands(
  state: RunState,
  commands: readonly Command[],
): RunState {
  const ctx = createContext(
    { schemaVersion: 1, key: "", start: { to: "" }, nodes: {} },
    state,
    { newId: () => "", now: "" },
  );
  for (const command of commands) {
    apply(ctx, command);
  }
  return {
    run: ctx.run,
    visits: ctx.visits,
    laneGroups: ctx.groups,
    lanes: ctx.lanes,
    visitTasks: ctx.visitTasks,
    tasks: [...ctx.tasks.values()],
    questions: ctx.questions,
    workItem: ctx.workItem,
  };
}

export function emit(ctx: EngineContext, command: Command): void {
  ctx.commands.push(command);
  apply(ctx, command);
}

export function visitById(ctx: EngineContext, id: string): Visit {
  const visit = ctx.visits.find((candidate) => candidate.id === id);
  if (visit === undefined) {
    throw new Error(`visit ${id} is not in the run state`);
  }
  return visit;
}

export function groupById(ctx: EngineContext, id: string): LaneGroup {
  const group = ctx.groups.find((candidate) => candidate.id === id);
  if (group === undefined) {
    throw new Error(`lane group ${id} is not in the run state`);
  }
  return group;
}

export function laneById(ctx: EngineContext, id: string): Lane {
  const lane = ctx.lanes.find((candidate) => candidate.id === id);
  if (lane === undefined) {
    throw new Error(`lane ${id} is not in the run state`);
  }
  return lane;
}

export function questionById(ctx: EngineContext, id: string): VisitQuestion {
  const question = ctx.questions.find((candidate) => candidate.id === id);
  if (question === undefined) {
    throw new Error(`question ${id} is not in the run state`);
  }
  return question;
}

export function nodeOf(ctx: EngineContext, nodeId: string): PipelineNode {
  const node = ctx.document.nodes[nodeId];
  if (node === undefined) {
    throw new Error(`node "${nodeId}" is not in the pipeline`);
  }
  return node;
}

export function lanesOf(ctx: EngineContext, groupId: string): Lane[] {
  return ctx.lanes
    .filter((lane) => lane.laneGroupId === groupId)
    .sort((left, right) => left.index - right.index);
}

/** The visit's Tasks, oldest attempt first. */
export function tasksOfVisit(ctx: EngineContext, visitId: string): VisitTask[] {
  return ctx.visitTasks
    .filter((link) => link.visitId === visitId)
    .sort((left, right) => left.attemptNumber - right.attemptNumber);
}

export function latestTaskOf(
  ctx: EngineContext,
  visitId: string,
): VisitTask | undefined {
  return tasksOfVisit(ctx, visitId).at(-1);
}

const FINISHED_TASK_STATUSES = new Set<TaskRunStatus>([
  "succeeded",
  "failed",
  "timeout",
  "cancelled",
  "skipped",
  "yielded",
]);

export function isTaskOpen(ctx: EngineContext, taskId: string): boolean {
  const task = ctx.tasks.get(taskId);
  return task !== undefined && !FINISHED_TASK_STATUSES.has(task.status);
}

export function isVisitOpen(visit: Visit): boolean {
  return visit.status === "active" || visit.status === "waiting";
}

export function isRunFinished(run: RunInfo): boolean {
  return (
    run.status === "succeeded" ||
    run.status === "failed" ||
    run.status === "cancelled"
  );
}
