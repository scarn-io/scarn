import type {
  JsonValue,
  PipelineDocument,
  StepCatalog,
} from "@scarn/sdk/contracts/pipeline-document";
import { validatePipeline } from "@scarn/shared-core/pipelines";
import { decide } from "@/pipeline-executions/pipeline-run/domain/engine/decide";
import { applyCommands } from "@/pipeline-executions/pipeline-run/domain/engine/state";
import type {
  Command,
  DecideResult,
  EngineEvent,
  RunState,
  Visit,
  VisitQuestion,
  VisitTransition,
} from "@/pipeline-executions/pipeline-run/domain/engine/types";
import { ENGINE_ERRORS } from "@/pipeline-executions/pipeline-run/domain/engine/types";
import {
  FAILED_RUN_STATUSES,
  retryDecision,
} from "@/tasks/task/domain/retry-decision";

/** A retry run the Task queued itself, out of the engine's sight. */
export interface RetriedRun {
  visitId: string;
  attemptNumber: number;
  taskId: string;
}

export const WORK_ITEM = {
  title: "Checkout crashes",
  description: "The checkout page crashes after applying a coupon.",
  fields: {
    "What are the Company Name(s):": "Acme",
    "What are the Employee Email(s):": "ana@example.com",
  },
};

export interface VisitFilter {
  item?: number;
  status?: Visit["status"];
}

/**
 * Drives `decide` like the transactional layer would: applies each result's
 * commands to the run state, and plays the worker's part by setting Task
 * results before reporting them.
 */
export class RunSimulator {
  readonly document: PipelineDocument;
  state: RunState;
  last: DecideResult = { commands: [] };
  /** Retry runs queued by the latest `fail`/`abandon`, as `onRunEnded` would. */
  retried: RetriedRun[] = [];
  /** The continuation run the latest `reply` queued on the Task, as `replyToTask` would. */
  continued: RetriedRun | null = null;
  private counter = 0;

  constructor(document: object, steps: StepCatalog) {
    const validation = validatePipeline(document, steps);
    if (!validation.ok) {
      throw new Error(
        `fixture is invalid: ${JSON.stringify(validation.errors)}`,
      );
    }
    this.document = validation.document;
    this.state = {
      run: {
        id: "run",
        status: "active",
        endNodeId: null,
        error: null,
        cancelledByUserId: null,
        completedAt: null,
      },
      visits: [],
      laneGroups: [],
      lanes: [],
      visitTasks: [],
      tasks: [],
      questions: [],
      workItem: structuredClone(WORK_ITEM),
    };
  }

  send(event: EngineEvent): DecideResult {
    this.last = decide(this.document, this.state, event, {
      newId: () => `id-${String(++this.counter)}`,
      now: `2026-10-24T00:00:${String(this.counter).padStart(2, "0")}Z`,
    });
    this.state = applyCommands(this.state, this.last.commands);
    return this.last;
  }

  start(): this {
    this.send({ type: "start" });
    return this;
  }

  /** Lane item index of a visit, or undefined at the top level. */
  itemOf(visit: Visit): number | undefined {
    if (visit.laneId === null) {
      return undefined;
    }
    return this.state.lanes.find((lane) => lane.id === visit.laneId)?.index;
  }

  visits(nodeId: string, filter: VisitFilter = {}): Visit[] {
    return this.state.visits.filter(
      (visit) =>
        visit.nodeId === nodeId &&
        (filter.status === undefined || visit.status === filter.status) &&
        (filter.item === undefined || this.itemOf(visit) === filter.item),
    );
  }

  /** The single open visit to `nodeId` (optionally on lane `item`). */
  open(nodeId: string, item?: number): Visit {
    const open = this.visits(nodeId, item === undefined ? {} : { item }).filter(
      (visit) => visit.status === "active" || visit.status === "waiting",
    );
    if (open.length !== 1) {
      throw new Error(
        `expected one open "${nodeId}" visit, found ${String(open.length)}`,
      );
    }
    return open[0] as Visit;
  }

  latestTaskId(visitId: string): string {
    const links = this.state.visitTasks
      .filter((link) => link.visitId === visitId)
      .sort((left, right) => left.attemptNumber - right.attemptNumber);
    const link = links.at(-1);
    if (link === undefined) {
      throw new Error(`visit ${visitId} has no Task`);
    }
    return link.taskId;
  }

  /** The ids a Task event on run `taskRunId` carries: its visit's Task and the run. */
  taskIds(taskRunId: string): { taskId: string; taskRunId: string } {
    const link = this.state.visitTasks.find(
      (entry) => entry.taskId === taskRunId,
    );
    const visit = this.state.visits.find((entry) => entry.id === link?.visitId);
    if (visit?.taskId == null) {
      throw new Error(`task run ${taskRunId} has no visit Task`);
    }
    return { taskId: visit.taskId, taskRunId };
  }

  task(taskId: string) {
    const task = this.state.tasks.find((entry) => entry.id === taskId);
    if (task === undefined) {
      throw new Error(`task ${taskId} is missing`);
    }
    return task;
  }

  /** The worker completes the open visit's Task with `result`. */
  succeed(
    nodeId: string,
    result: JsonValue,
    options: { item?: number; workBranch?: string } = {},
  ): DecideResult {
    const taskId = this.latestTaskId(this.open(nodeId, options.item).id);
    return this.succeedTask(taskId, result, options.workBranch);
  }

  succeedTask(
    taskId: string,
    result: JsonValue,
    workBranch?: string,
  ): DecideResult {
    Object.assign(this.task(taskId), {
      status: "succeeded",
      result,
      workBranch: workBranch ?? null,
    });
    return this.send({ type: "task_succeeded", ...this.taskIds(taskId) });
  }

  /** The worker yields the open visit's Task: its agent hands over with `message`. */
  yield(
    nodeId: string,
    message: string,
    options: { item?: number; workBranch?: string } = {},
  ): DecideResult {
    const taskId = this.latestTaskId(this.open(nodeId, options.item).id);
    return this.yieldTask(taskId, message, options.workBranch);
  }

  yieldTask(
    taskId: string,
    message: string,
    workBranch?: string,
  ): DecideResult {
    Object.assign(this.task(taskId), {
      status: "yielded",
      workBranch: workBranch ?? null,
    });
    const result = this.send({
      type: "task_waiting",
      ...this.taskIds(taskId),
      message,
    });
    this.handOverInTaskConversation(taskId);
    return result;
  }

  /**
   * A hand-over the engine let wait opens its Task's conversation, which the
   * repo loads onto the visit (`conversationId` comes from the visit's Task).
   */
  private handOverInTaskConversation(taskRunId: string): void {
    const link = this.state.visitTasks.find(
      (entry) => entry.taskId === taskRunId,
    );
    const visit = this.state.visits.find((entry) => entry.id === link?.visitId);
    if (visit?.status === "waiting" && visit.taskId !== null) {
      visit.conversationId ??= `conversation-${visit.taskId}`;
    }
  }

  /**
   * A person replies in the conversation of `nodeId`'s open visit, the way
   * `replyToTask` does: a waiting visit's Task queues its continuation run,
   * unseen by the engine, which hears `task_resumed` with it. On a visit
   * that isn't waiting the engine hears it with the latest run.
   */
  reply(nodeId: string, item?: number): DecideResult {
    const visit = this.open(nodeId, item);
    const latest = this.latestTaskId(visit.id);
    if (visit.status !== "waiting") {
      return this.send({ type: "task_resumed", ...this.taskIds(latest) });
    }
    const continuation: RetriedRun = {
      visitId: visit.id,
      attemptNumber:
        (this.state.visitTasks.find((link) => link.taskId === latest)
          ?.attemptNumber ?? 0) + 1,
      taskId: `continuation-${String(++this.counter)}`,
    };
    this.state.visitTasks.push(continuation);
    this.state.tasks.push({
      id: continuation.taskId,
      status: "queued",
      result: null,
      error: null,
      workBranch: null,
    });
    this.continued = continuation;
    return this.send({
      type: "task_resumed",
      ...this.taskIds(continuation.taskId),
    });
  }

  /** A person ends the conversation of `nodeId`'s open visit: its Task succeeds with its own result. */
  end(nodeId: string, summary: string): DecideResult {
    const visit = this.open(nodeId);
    return this.send({
      type: "task_succeeded",
      ...this.taskIds(this.latestTaskId(visit.id)),
      result: { conversationId: visit.conversationId, summary },
    });
  }

  fail(
    nodeId: string,
    options: { item?: number; name?: string; message?: string } = {},
  ): DecideResult {
    return this.endInFailure(this.open(nodeId, options.item), "failed", {
      ...(options.name === undefined ? {} : { name: options.name }),
      message: options.message ?? "boom",
    });
  }

  /**
   * The open visit's Task yields with no turns left. A yield isn't a failed
   * run, so the Task never retries it; the engine hears `task_failed`.
   */
  exceedTurns(nodeId: string, message?: string): DecideResult {
    const taskId = this.latestTaskId(this.open(nodeId).id);
    Object.assign(this.task(taskId), { status: "yielded" });
    this.retried = [];
    return this.send({
      type: "task_failed",
      ...this.taskIds(taskId),
      error: {
        name: ENGINE_ERRORS.maxTurnsExceeded,
        message: message ?? "no turns left",
      },
    });
  }

  abandon(nodeId: string, item?: number): DecideResult {
    return this.endInFailure(this.open(nodeId, item), "abandoned", {
      name: ENGINE_ERRORS.heartbeatTimeout,
      message: "The step stopped sending heartbeats",
    });
  }

  /**
   * Ends the visit's latest run in failure the way `onRunEnded` does: the
   * Task's retry policy (the node's `retry`) queues a retry run unseen by the
   * engine, or else the engine hears `task_failed`.
   */
  private endInFailure(
    visit: Visit,
    status: "failed" | "abandoned",
    error: { name?: string; message: string },
  ): DecideResult {
    const links = this.state.visitTasks
      .filter((link) => link.visitId === visit.id)
      .sort((left, right) => left.attemptNumber - right.attemptNumber);
    const latest = links.at(-1);
    if (latest === undefined) {
      throw new Error(`visit ${visit.id} has no Task`);
    }
    Object.assign(this.task(latest.taskId), { status });
    const node = this.document.nodes[visit.nodeId];
    const attempts = links
      .slice(0, -1)
      .filter((link) =>
        FAILED_RUN_STATUSES.has(this.task(link.taskId).status),
      ).length;
    if (
      node?.kind === "step" &&
      retryDecision(
        node.retry ?? null,
        { name: error.name ?? ENGINE_ERRORS.stepFailed },
        attempts,
      ).retry
    ) {
      const retry: RetriedRun = {
        visitId: visit.id,
        attemptNumber: latest.attemptNumber + 1,
        taskId: `retry-${String(++this.counter)}`,
      };
      this.state.visitTasks.push(retry);
      this.state.tasks.push({
        id: retry.taskId,
        status: "queued",
        result: null,
        error: null,
        workBranch: null,
      });
      this.retried = [retry];
      this.last = { commands: [] };
      return this.last;
    }
    this.retried = [];
    return this.send({
      type: "task_failed",
      ...this.taskIds(latest.taskId),
      error,
    });
  }

  /** A person chooses `action` on `nodeId`'s waiting decision visit. */
  decide(
    nodeId: string,
    action: string,
    body: string | null = null,
  ): DecideResult {
    return this.send({
      type: "decision_made",
      visitId: this.open(nodeId).id,
      action,
      body,
      userId: "reviewer",
    });
  }

  /** Questions asked by visits to `nodeId`, in the order they were asked. */
  questions(nodeId: string): VisitQuestion[] {
    const visitIds = new Set(this.visits(nodeId).map((visit) => visit.id));
    return this.state.questions.filter((question) =>
      visitIds.has(question.visitId),
    );
  }

  /** The single open question asked by `nodeId`'s open visit. */
  openQuestion(nodeId: string): VisitQuestion {
    const visitId = this.open(nodeId).id;
    const open = this.state.questions.filter(
      (question) => question.visitId === visitId && question.status === "open",
    );
    if (open.length !== 1) {
      throw new Error(
        `expected one open question on "${nodeId}", found ${String(open.length)}`,
      );
    }
    return open[0] as VisitQuestion;
  }

  /** Answers `questionId` with a comment, or continues without reply when `body` is null. */
  answer(questionId: string, body: string | null): DecideResult {
    return this.send({
      type: "question_answered",
      questionId,
      userId: "reporter",
      answer:
        body === null ? null : { commentId: `answer-${questionId}`, body },
    });
  }

  asked(): Extract<Command, { type: "askQuestion" }>[] {
    return this.last.commands.filter(
      (command): command is Extract<Command, { type: "askQuestion" }> =>
        command.type === "askQuestion",
    );
  }

  rerun(visitId: string, message?: string): DecideResult {
    return this.send({
      type: "rerun_from",
      visitId,
      userId: "rerunner",
      ...(message === undefined ? {} : { message }),
    });
  }

  overrule(
    visitId: string,
    routes: VisitTransition[],
    options: {
      reason?: string;
      missingArgs?: "accept" | "reject_code_step";
    } = {},
  ): DecideResult {
    const { reason = "reviewed by hand" } = options;
    const missingArgs = options.missingArgs ?? ("reject" as const);
    const event = { visitId, routes, reason, missingArgs, userId: "overruler" };
    return this.send({ type: "route_overruled", ...event });
  }

  /** `node[#item]:status` for every visit, in creation order. */
  trail(): string[] {
    return this.state.visits.map((visit) => {
      const item = this.itemOf(visit);
      return `${visit.nodeId}${item === undefined ? "" : `#${String(item)}`}:${visit.status}`;
    });
  }

  laneStatuses(): string[] {
    return [...this.state.lanes]
      .sort((left, right) => left.index - right.index)
      .map((lane) => lane.status);
  }

  queued(): Extract<Command, { type: "queueTask" }>["task"][] {
    return this.last.commands
      .filter(
        (command): command is Extract<Command, { type: "queueTask" }> =>
          command.type === "queueTask",
      )
      .map((command) => command.task);
  }

  cancelledTasks(): string[] {
    return this.last.commands
      .filter(
        (command): command is Extract<Command, { type: "cancelTask" }> =>
          command.type === "cancelTask",
      )
      .map((command) => command.taskId);
  }
}
