import type { TaskKind } from "@scarn/core/tasks/task-run/domain/task-run-entity";

/** What a new Task is, as far as whether its agent may ask for grants. */
export type GrantRequestsSubject = {
  kind: TaskKind;
  workItemId: string | null;
  /** null for a prompt Task. */
  stepDefinitionId: string | null;
  /** Whether the Task's step definition declares `grantRequests`. */
  stepGrantRequests?: boolean | undefined;
  startedByUserId: string | null;
  startedByAutomationId: string | null;
  startedByScheduleId: string | null;
};

/**
 * Whether a new Task's agent may ask a person for more grants: only an
 * `agent` Task on a work item, started by a person (no automation or
 * schedule), that is a prompt Task or whose step declares `grantRequests`.
 * Code and MCP tool Tasks and chats never may. The work item's platform
 * doesn't matter here: a change to an item synced from another tracker is
 * refused when it applies (`validateWorkItemChanges`).
 */
export const taskMayRequestGrants = (subject: GrantRequestsSubject): boolean =>
  subject.kind === "agent" &&
  subject.workItemId !== null &&
  subject.startedByUserId !== null &&
  subject.startedByAutomationId === null &&
  subject.startedByScheduleId === null &&
  (subject.stepDefinitionId === null || subject.stepGrantRequests === true);
