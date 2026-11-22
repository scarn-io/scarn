/**
 * Step visits that hand over: a yielded Task (which posted its agent's final
 * message to its conversation) makes the visit wait; a reply (or continuing
 * without one) resumes the Task, which queues its next run, and the visit
 * is active again.
 */
import { withNotes } from "./enter";
import { buildAgentMessageBody } from "./questions";
import { emit, nodeOf, type EngineContext } from "./state";
import type { EngineEvent, Visit } from "./types";

/** Makes `visit` wait on its Task's conversation, noting when the message was cut. */
export function onTaskYielded(
  ctx: EngineContext,
  visit: Visit,
  event: Extract<EngineEvent, { type: "task_waiting" }>,
): void {
  const node = nodeOf(ctx, visit.nodeId);
  if (node.kind !== "step") {
    throw new Error(`visit ${visit.id} on "${visit.nodeId}" isn't a step`);
  }
  const message = buildAgentMessageBody(event.message);
  emit(ctx, {
    type: "updateVisit",
    visitId: visit.id,
    patch: {
      status: "waiting",
      ...(message.notes.length === 0
        ? {}
        : { routing: withNotes(visit.routing, message.notes) }),
    },
  });
}

/**
 * A person's reply resumed the visit's Task, which queued its continuation
 * itself: the visit is active again.
 */
export function onTaskResumed(ctx: EngineContext, visit: Visit): void {
  emit(ctx, {
    type: "updateVisit",
    visitId: visit.id,
    patch: { status: "active" },
  });
}
