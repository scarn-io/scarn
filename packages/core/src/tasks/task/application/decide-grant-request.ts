/**
 * A person decides a Task's pending grant request: approves all, some or
 * none of the requested grants. The approved ones join the Task's grants, a
 * `system` message linked to the request says what was decided, and the
 * Task resumes with a `continuation` run, as Continue does.
 */
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import {
  CoreError,
  CoreValidationError,
  InvariantViolationError,
  ResourceNotFoundError,
} from "@scarn/core/lib/errors";
import { Result } from "@scarn/core/lib/result";
import { postConversationSystemMessage } from "@scarn/core/conversations/conversation/application/send-conversation-message";
import {
  decideGrantRequestInputSchema,
  type DecideGrantRequestInput,
} from "@scarn/core/tasks/grant-request/contracts/grant-request-contracts";
import {
  approvalRefusals,
  approvedCount,
  decideGrantRequest as decide,
  type GrantRequest,
} from "@scarn/core/tasks/grant-request/domain/grant-request";
import type { Grant } from "../domain/grants";
import {
  actorName,
  resume,
  type ActedOnTask,
  type ActOnTaskDeps,
} from "./resume-task";

const notPending = (request: GrantRequest) =>
  new CoreError({
    code: "GRANT_REQUEST_NOT_PENDING",
    message: `Grant request ${request.id} isn't pending`,
    status: 409,
  });

/** "alex approved 2 of 3 requested grants", or "alex denied the request". */
const decisionMessage = (name: string, decided: GrantRequest): string => {
  const approved = approvedCount(decided);
  const requested = decided.requested.length;
  if (approved === 0) {
    return `${name} denied the request`;
  }
  if (approved === requested) {
    return requested === 1
      ? `${name} approved the requested grant`
      : `${name} approved all ${String(requested)} requested grants`;
  }
  return `${name} approved ${String(approved)} of ${String(requested)} requested grants`;
};

/**
 * Locks the request's conversation, then its Task (the order a yield takes
 * them), and checks both still wait on this request: 409
 * `GRANT_REQUEST_NOT_PENDING` otherwise.
 */
const lockPending = async (
  request: GrantRequest,
  deps: ActOnTaskDeps,
  tx: DbExecutor,
) => {
  const unlocked = await deps.taskRepo.load(request.taskId, tx);
  if (unlocked?.conversationId == null) {
    throw new InvariantViolationError(
      `Grant request ${request.id} has no Task conversation`,
      "GRANT_REQUEST_CONVERSATION_MISSING",
    );
  }
  const conversation = await deps.conversationRepo.lock(
    unlocked.conversationId,
    tx,
  );
  const task = await deps.taskRepo.lock(request.taskId, tx);
  if (!conversation || !task) {
    throw new InvariantViolationError(
      `Grant request ${request.id} lost its Task or conversation`,
      "GRANT_REQUEST_CONVERSATION_MISSING",
    );
  }
  const pending = await deps.grantRequestRepo.findPendingByTaskId(task.id, tx);
  if (pending?.id !== request.id || task.status !== "waiting_for_person") {
    throw notPending(request);
  }
  return { conversation, task, pending };
};

/** `executions:write`, plus `work-items:write` when an approved grant changes work items. */
const requirePermissions = async (
  request: GrantRequest,
  approved: readonly Grant[],
  deps: ActOnTaskDeps,
  tx: DbExecutor,
) => {
  await deps.userAuthz.requireProjectPermission({
    projectId: request.projectId,
    permission: "executions:write",
    dbExecutor: tx,
  });
  if (approved.some((grant) => grant.action !== "read")) {
    await deps.userAuthz.requireProjectPermission({
      projectId: request.projectId,
      permission: "work-items:write",
      dbExecutor: tx,
    });
  }
};

/**
 * Decides the pending grant request `grantRequestId` with `approved` (`[]`
 * denies) and an optional `note`. Each approved grant must be covered by a
 * requested one (422 `GRANT_REQUEST_APPROVAL_INVALID`). Needs
 * `executions:write`, and `work-items:write` when an approved grant isn't
 * `read`. Runs in `tx`.
 */
export const decideGrantRequest = async (
  input: DecideGrantRequestInput,
  deps: ActOnTaskDeps,
  tx: DbExecutor,
): Promise<Result<ActedOnTask, ResourceNotFoundError>> => {
  const { grantRequestId, approved, note } =
    decideGrantRequestInputSchema.parse(input);
  const request = await deps.grantRequestRepo.load(grantRequestId, tx);
  if (!request) {
    return Result.err(
      new ResourceNotFoundError("GrantRequest", grantRequestId),
    );
  }
  await requirePermissions(request, approved, deps, tx);
  const { conversation, task, pending } = await lockPending(request, deps, tx);
  const refusals = approvalRefusals(pending, approved);
  if (refusals.length > 0) {
    throw new CoreValidationError(
      `The approval isn't part of the request: ${refusals.join("; ")}`,
      "GRANT_REQUEST_APPROVAL_INVALID",
      { refusals },
    );
  }
  const now = deps.timeProvider.now();
  const decided = await deps.grantRequestRepo.save(
    decide(pending, {
      approved,
      note: note === undefined || note === "" ? null : note,
      userId: deps.userAuthz.actorId,
      now,
    }),
    tx,
  );
  const granted = await deps.taskRepo.save(task.withGrants(approved, now), tx);
  await postConversationSystemMessage(
    conversation,
    {
      body: decisionMessage(await actorName(deps, tx), decided),
      grantRequestId: decided.id,
    },
    (current, at) => current.acceptPersonMessage(at),
    { ...deps, actorId: deps.userAuthz.actorId },
    tx,
  );
  await resume(granted, deps, tx);
  return Result.ok({ conversationId: conversation.id });
};
