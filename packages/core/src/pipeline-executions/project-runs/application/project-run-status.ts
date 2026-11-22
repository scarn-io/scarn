import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { TaskStatus } from "@scarn/core/tasks/task/domain/task-entity";
import type {
  PipelineExecutionDisplayStatus,
  WaitFor,
} from "../../pipeline-run/contracts/pipeline-run-contracts";
import type { ProjectRunStatus } from "../contracts/project-runs-contracts";

/** What each kind of row's status is derived from. */
export type ProjectRunStatusFacts =
  | {
      type: "pipeline";
      /** The run's display status (`deriveDisplayStatus`). */
      status: PipelineExecutionDisplayStatus;
      /** `deriveWaitingFor`: null unless waiting on a decision or reply. */
      waitingFor: WaitFor | null;
      /** Set when the run reached an end node. */
      endNodeId: string | null;
      waitingOnYou: boolean;
    }
  | {
      type: "task";
      /** The Task's effective status. */
      status: TaskStatus;
      waitingOnYou: boolean;
      /** Whether the Task has no work item and its conversation is closed. */
      conversationClosed: boolean;
    };

const pipelineStatus = (
  facts: Extract<ProjectRunStatusFacts, { type: "pipeline" }>,
): ProjectRunStatus => {
  switch (facts.status) {
    case "waiting":
      return facts.waitingFor !== null && facts.waitingOnYou
        ? "needs-you"
        : "waiting";
    case "running":
    case "queued":
    case "cancelled":
      return facts.status;
    case "succeeded":
      return "done";
    case "failed":
      return facts.endNodeId === null ? "failed" : "ended";
  }
};

const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = [
  "succeeded",
  "failed",
  "cancelled",
];

const taskStatus = (
  facts: Extract<ProjectRunStatusFacts, { type: "task" }>,
): ProjectRunStatus => {
  if (
    facts.conversationClosed &&
    !TERMINAL_TASK_STATUSES.includes(facts.status)
  ) {
    return "done";
  }
  switch (facts.status) {
    case "waiting_for_person":
      return facts.waitingOnYou ? "needs-you" : "waiting";
    case "running":
      return "running";
    case "queued":
    case "waiting_for_work":
    case "waiting_for_concurrency_slot":
      return "queued";
    case "succeeded":
      return "done";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
  }
};

/**
 * The status people see for a pipeline run or a Task. `needs-you` and
 * `waiting` split one wait by whether it is on the viewer; a pipeline run
 * that failed at an end node `ended` (a designed outcome), one that failed
 * anywhere else `failed` (it crashed). A Task without a work item whose
 * conversation was closed before the Task ended is `done`.
 */
export const deriveProjectRunStatus = (
  facts: ProjectRunStatusFacts,
): ProjectRunStatus => {
  switch (facts.type) {
    case "pipeline":
      return pipelineStatus(facts);
    case "task":
      return taskStatus(facts);
  }
};

/**
 * Who a pipeline run waits on, as the viewer sees it. `waiterUserIds` are
 * the run's work item's waiters (`workItemWaitingOnUserIds`: assignee and
 * creator, or the nearest parent's, then the run's starter) so it agrees
 * with the Inbox. Nobody unless the run waits on a decision or reply;
 * `viewerUserId` is null for a guest, who is never waited on.
 */
export const pipelineRunWaitingOn = ({
  waitingFor,
  waiterUserIds,
  viewerUserId,
}: {
  waitingFor: WaitFor | null;
  waiterUserIds: readonly UuidV7[];
  viewerUserId: UuidV7 | null;
}): { waitingOnYou: boolean; waitingOnUserIds: UuidV7[] } => {
  if (waitingFor === null) {
    return { waitingOnYou: false, waitingOnUserIds: [] };
  }
  const waitingOnUserIds = [...new Set(waiterUserIds)];
  return {
    waitingOnYou:
      viewerUserId !== null && waitingOnUserIds.includes(viewerUserId),
    waitingOnUserIds,
  };
};
