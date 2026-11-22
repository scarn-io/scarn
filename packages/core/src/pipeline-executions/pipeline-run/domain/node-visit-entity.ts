/**
 * A visit: "the run entered node X, on lane L, from visit V". Step, wait and
 * end (succeed/fail) visits are separate variants: only a step visit points
 * at a result Task, and only a wait visit holds a person's resolution. The
 * nullable `node_visits` row shape stays in the repository.
 */
import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { InvariantViolationError } from "@scarn/core/lib/errors";
import type {
  JsonObject,
  JsonValue,
} from "@scarn/sdk/contracts/pipeline-document";
import type {
  Routing,
  EngineError,
  Visit,
  VisitPatch,
  VisitStatus,
  VisitTransition,
} from "./engine/types";

export type DecisionWaitResult = { action: string; body: string | null };
export type ReplyWaitResult = {
  replied: boolean;
  body: string | null;
  commentId: string | null;
};
export type WaitResult = DecisionWaitResult | ReplyWaitResult;

type NodeVisitBaseProps = {
  id: UuidV7;
  pipelineRunId: UuidV7;
  nodeId: string;
  laneId: UuidV7 | null;
  fromVisitId: UuidV7 | null;
  fromLaneGroupId: UuidV7 | null;
  transition: VisitTransition;
  routing: Routing | null;
  status: VisitStatus;
  input: JsonObject;
  error: EngineError | null;
  createdByUserId: UuidV7 | null;
  createdAt: Date;
  completedAt: Date | null;
  /** A step visit's conversation, set by its first hand-off; null otherwise. */
  conversationId: UuidV7 | null;
};

/**
 * `taskId` is the visit's Task, set when it queues its first run.
 * `resultTaskId` is the run whose result is the visit's; it is not stored but
 * derived on load (the latest run, once it succeeded). `result` is set only
 * when the visit ended without a result run: a person ended its conversation
 * (`{ conversationId, summary }`).
 */
export type StepVisitProps = NodeVisitBaseProps & {
  taskId: UuidV7 | null;
  resultTaskId: UuidV7 | null;
  result: JsonValue | null;
};

export type WaitVisitProps = NodeVisitBaseProps & {
  result: WaitResult | null;
  resolvedByUserId: UuidV7 | null;
  resolvedAt: Date | null;
};

export type EndVisitProps = NodeVisitBaseProps & {
  nodeKind: "succeed" | "fail";
};

/** The flat `node_visits` row, as the repository reads and writes it. */
export type NodeVisitRowProps = NodeVisitBaseProps & {
  nodeKind: Visit["nodeKind"];
  taskId: UuidV7 | null;
  resultTaskId: UuidV7 | null;
  result: JsonValue | null;
  resolvedByUserId: UuidV7 | null;
  resolvedAt: Date | null;
};

const optionalUuid = (value: string | null): UuidV7 | null =>
  value === null ? null : parseUuidV7(value);

const toDate = (value: string | null): Date | null =>
  value === null ? null : new Date(value);

const baseFromEngine = (
  pipelineRunId: UuidV7,
  visit: Visit,
): NodeVisitBaseProps => ({
  id: parseUuidV7(visit.id),
  pipelineRunId,
  nodeId: visit.nodeId,
  laneId: optionalUuid(visit.laneId),
  fromVisitId: optionalUuid(visit.fromVisitId),
  fromLaneGroupId: optionalUuid(visit.fromLaneGroupId),
  transition: visit.transition,
  routing: visit.routing,
  status: visit.status,
  input: visit.input,
  error: visit.error,
  createdByUserId: optionalUuid(visit.createdByUserId),
  createdAt: new Date(visit.createdAt),
  completedAt: toDate(visit.completedAt),
  conversationId: optionalUuid(visit.conversationId),
});

abstract class NodeVisitEntityBase<TProps extends NodeVisitBaseProps> {
  public abstract readonly nodeKind: Visit["nodeKind"];

  protected constructor(protected readonly props: TProps) {}

  get id(): UuidV7 {
    return this.props.id;
  }
  get pipelineRunId(): UuidV7 {
    return this.props.pipelineRunId;
  }
  get nodeId(): string {
    return this.props.nodeId;
  }
  get laneId(): UuidV7 | null {
    return this.props.laneId;
  }
  get fromVisitId(): UuidV7 | null {
    return this.props.fromVisitId;
  }
  get fromLaneGroupId(): UuidV7 | null {
    return this.props.fromLaneGroupId;
  }
  get transition(): VisitTransition {
    return this.props.transition;
  }
  get routing(): Routing | null {
    return this.props.routing;
  }
  get status(): VisitStatus {
    return this.props.status;
  }
  get input(): JsonObject {
    return this.props.input;
  }
  get error(): EngineError | null {
    return this.props.error;
  }
  get createdByUserId(): UuidV7 | null {
    return this.props.createdByUserId;
  }
  get createdAt(): Date {
    return this.props.createdAt;
  }
  get completedAt(): Date | null {
    return this.props.completedAt;
  }
  get conversationId(): UuidV7 | null {
    return this.props.conversationId;
  }
  get isOpen(): boolean {
    return this.status === "active" || this.status === "waiting";
  }

  protected patchedBase(patch: VisitPatch): TProps {
    return {
      ...this.props,
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.routing !== undefined ? { routing: patch.routing } : {}),
      ...(patch.error !== undefined ? { error: patch.error } : {}),
      ...(patch.completedAt !== undefined
        ? { completedAt: toDate(patch.completedAt) }
        : {}),
    };
  }

  protected engineBase(): Omit<
    Visit,
    | "nodeKind"
    | "taskId"
    | "resultTaskId"
    | "result"
    | "resolvedByUserId"
    | "resolvedAt"
  > {
    return {
      id: this.id,
      nodeId: this.nodeId,
      laneId: this.laneId,
      fromVisitId: this.fromVisitId,
      fromLaneGroupId: this.fromLaneGroupId,
      transition: this.transition,
      routing: this.routing,
      status: this.status,
      input: this.input,
      error: this.error,
      createdByUserId: this.createdByUserId,
      createdAt: this.createdAt.toISOString(),
      completedAt: this.completedAt?.toISOString() ?? null,
      conversationId: this.conversationId,
    };
  }

  abstract withPatch(patch: VisitPatch): NodeVisitEntity;
  abstract toEngineVisit(): Visit;
  abstract toRow(): NodeVisitRowProps;
}

/**
 * A step visit. Its result is its succeeded run's result (`resultTaskId`),
 * or, for a conversation a person ended, `{ conversationId, summary }`.
 */
export class StepVisitEntity extends NodeVisitEntityBase<StepVisitProps> {
  public readonly nodeKind = "step" as const;

  static rehydrate(props: StepVisitProps): StepVisitEntity {
    return new StepVisitEntity(props);
  }

  get taskId(): UuidV7 | null {
    return this.props.taskId;
  }
  get resultTaskId(): UuidV7 | null {
    return this.props.resultTaskId;
  }

  withTaskId(taskId: UuidV7): StepVisitEntity {
    return new StepVisitEntity({ ...this.props, taskId });
  }
  get result(): JsonValue | null {
    return this.props.result;
  }

  withPatch(patch: VisitPatch): StepVisitEntity {
    return new StepVisitEntity({
      ...this.patchedBase(patch),
      ...(patch.resultTaskId !== undefined
        ? { resultTaskId: optionalUuid(patch.resultTaskId) }
        : {}),
      ...(patch.result !== undefined ? { result: patch.result } : {}),
    });
  }

  toEngineVisit(): Visit {
    return {
      ...this.engineBase(),
      nodeKind: "step",
      taskId: this.taskId,
      resultTaskId: this.resultTaskId,
      result: this.result,
      resolvedByUserId: null,
      resolvedAt: null,
    };
  }

  toRow(): NodeVisitRowProps {
    return {
      ...this.props,
      nodeKind: "step",
      resolvedByUserId: null,
      resolvedAt: null,
    };
  }
}

/**
 * A wait visit. A decision's result is `{ action, body }`; a reply's is
 * `{ replied, body, commentId }`.
 */
export class WaitVisitEntity extends NodeVisitEntityBase<WaitVisitProps> {
  public readonly nodeKind = "wait" as const;

  static rehydrate(props: WaitVisitProps): WaitVisitEntity {
    return new WaitVisitEntity(props);
  }

  get result(): WaitResult | null {
    return this.props.result;
  }
  get resolvedByUserId(): UuidV7 | null {
    return this.props.resolvedByUserId;
  }
  get resolvedAt(): Date | null {
    return this.props.resolvedAt;
  }

  withPatch(patch: VisitPatch): WaitVisitEntity {
    return new WaitVisitEntity({
      ...this.patchedBase(patch),
      ...(patch.result !== undefined
        ? { result: parseWaitResult(patch.result) }
        : {}),
      ...(patch.resolvedByUserId !== undefined
        ? { resolvedByUserId: optionalUuid(patch.resolvedByUserId) }
        : {}),
      ...(patch.resolvedAt !== undefined
        ? { resolvedAt: toDate(patch.resolvedAt) }
        : {}),
    });
  }

  toEngineVisit(): Visit {
    return {
      ...this.engineBase(),
      nodeKind: "wait",
      taskId: null,
      resultTaskId: null,
      result: this.result,
      resolvedByUserId: this.resolvedByUserId,
      resolvedAt: this.resolvedAt?.toISOString() ?? null,
    };
  }

  toRow(): NodeVisitRowProps {
    return {
      ...this.props,
      nodeKind: "wait",
      taskId: null,
      resultTaskId: null,
    };
  }
}

/** A visit to a `succeed` or `fail` node: where a run or lane ended. */
export class EndVisitEntity extends NodeVisitEntityBase<EndVisitProps> {
  public readonly nodeKind: "succeed" | "fail";

  private constructor(props: EndVisitProps) {
    super(props);
    this.nodeKind = props.nodeKind;
  }

  static rehydrate(props: EndVisitProps): EndVisitEntity {
    return new EndVisitEntity(props);
  }

  withPatch(patch: VisitPatch): EndVisitEntity {
    return new EndVisitEntity(this.patchedBase(patch));
  }

  toEngineVisit(): Visit {
    return {
      ...this.engineBase(),
      nodeKind: this.nodeKind,
      taskId: null,
      resultTaskId: null,
      result: null,
      resolvedByUserId: null,
      resolvedAt: null,
    };
  }

  toRow(): NodeVisitRowProps {
    return {
      ...this.props,
      taskId: null,
      resultTaskId: null,
      result: null,
      resolvedByUserId: null,
      resolvedAt: null,
    };
  }
}

export type NodeVisitEntity =
  StepVisitEntity | WaitVisitEntity | EndVisitEntity;

const stringOrNull = (value: JsonValue | undefined): string | null =>
  typeof value === "string" ? value : null;

function parseWaitResult(value: JsonValue | null): WaitResult | null {
  if (value === null) {
    return null;
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    if (typeof value["action"] === "string") {
      return { action: value["action"], body: stringOrNull(value["body"]) };
    }
    if (typeof value["replied"] === "boolean") {
      return {
        replied: value["replied"],
        body: stringOrNull(value["body"]),
        commentId: stringOrNull(value["commentId"]),
      };
    }
  }
  throw new InvariantViolationError(
    "A wait visit's result must be { action, body } or { replied, body, commentId }",
    "NODE_VISIT_WAIT_RESULT_INVALID",
  );
}

export const NodeVisitEntity = {
  /** Maps the flat row to the variant its `nodeKind` names. */
  rehydrate(row: NodeVisitRowProps): NodeVisitEntity {
    const {
      nodeKind,
      taskId,
      resultTaskId,
      result,
      resolvedByUserId,
      resolvedAt,
      ...base
    } = row;
    switch (nodeKind) {
      case "step":
        return StepVisitEntity.rehydrate({
          ...base,
          taskId,
          resultTaskId,
          result,
        });
      case "wait":
        return WaitVisitEntity.rehydrate({
          ...base,
          result: parseWaitResult(result),
          resolvedByUserId,
          resolvedAt,
        });
      case "succeed":
      case "fail":
        return EndVisitEntity.rehydrate({ ...base, nodeKind });
    }
  },

  /** Builds the entity for a visit `decide` created. */
  fromEngineVisit(pipelineRunId: UuidV7, visit: Visit): NodeVisitEntity {
    return NodeVisitEntity.rehydrate({
      ...baseFromEngine(pipelineRunId, visit),
      nodeKind: visit.nodeKind,
      taskId: optionalUuid(visit.taskId),
      resultTaskId: optionalUuid(visit.resultTaskId),
      result: visit.result,
      resolvedByUserId: optionalUuid(visit.resolvedByUserId),
      resolvedAt: toDate(visit.resolvedAt),
    });
  },
};
