import {
  grantSentence,
  workItemPrompt,
} from "@scarn/sdk/definitions/steps/work-item-features";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { UsernameReader } from "@scarn/core/organizations/organization/application/username-reader";
import type { GrantRequestRepo } from "@scarn/core/tasks/grant-request/application/grant-request-repo";
import type { GrantRequest } from "@scarn/core/tasks/grant-request/domain/grant-request";
import { grantsNotHeld } from "@scarn/core/tasks/task/domain/grants";
import type { TaskRunEntity } from "../domain/task-run-entity";

/** What a continuation is told when its access request closed without a decision. */
export const UNANSWERED_GRANT_REQUEST_TEXT =
  "Your access request wasn't answered; nothing was granted.";

export const GRANTS_ADDED_HEADING = "## Grants added during this Task";

/**
 * What the agent is told about `request`: who answered, the prompt section
 * for each approved grant, a sentence for each requested grant (or label)
 * not granted, and the person's note. An `unanswered` request gets the
 * unanswered text; any other status gets null.
 */
export const buildGrantRequestDecisionText = (
  request: Pick<GrantRequest, "status" | "requested" | "approved" | "note">,
  deciderName: string,
): string | null => {
  if (request.status === "unanswered") {
    return UNANSWERED_GRANT_REQUEST_TEXT;
  }
  if (request.status !== "decided") {
    return null;
  }
  const approved = request.approved ?? [];
  const denied = grantsNotHeld(approved, request.requested);
  return [
    `${deciderName} answered your access request.`,
    ...(approved.length > 0
      ? [["Granted:", ...approved.map(workItemPrompt)].join("\n\n")]
      : []),
    ...(denied.length > 0
      ? [`Not granted: ${denied.map(grantSentence).join(" ")}`]
      : []),
    ...(request.note ? [`Note from ${deciderName}: ${request.note}`] : []),
  ].join("\n\n");
};

/**
 * The fallback prompt's block on every decided request, ending with a blank
 * line; empty when none was decided.
 */
export const buildGrantsAddedPromptLines = (decided: string[]): string[] =>
  decided.length === 0
    ? []
    : [GRANTS_ADDED_HEADING, "", ...decided.flatMap((text) => [text, ""])];

export const REQUEST_ACCESS_PROMPT_LINE =
  "If you need to do something your tools don't allow, call `scarn-request-access` with what you need and why, then end your turn.";

/** The prompt line pointing at `scarn-request-access`, when the Task may ask for grants. */
export const buildRequestAccessPromptLines = (
  grantRequests: boolean,
): string[] => (grantRequests ? [REQUEST_ACCESS_PROMPT_LINE] : []);

export type GrantRequestDecisions = {
  /**
   * The decision on the request the previous run yielded with, for a
   * `continuation` run; null otherwise.
   */
  latest: string | null;
  /** The text of every decided request of the Task, oldest first. */
  decided: string[];
};

/**
 * The decisions on `run`'s Task's grant requests. The latest is the newest
 * `decided` or `unanswered` request whose `taskRunId` is the run this one
 * continues.
 */
export const loadGrantRequestDecisions = async (
  run: TaskRunEntity,
  deps: {
    grantRequestRepo: Pick<GrantRequestRepo, "listByTaskId">;
    usernameReader: UsernameReader;
  },
): Promise<GrantRequestDecisions> => {
  const requests = await deps.grantRequestRepo.listByTaskId(run.taskId);
  if (requests.length === 0) {
    return { latest: null, decided: [] };
  }
  const deciders = requests.flatMap((request) =>
    request.decidedByUserId ? [request.decidedByUserId] : [],
  );
  const usernames = await deps.usernameReader.loadUsernamesByUserId(deciders);
  const nameOf = (userId: UuidV7 | null) =>
    (userId ? usernames.get(userId)?.username : null) ?? "Someone";
  const textOf = (request: GrantRequest) =>
    buildGrantRequestDecisionText(request, nameOf(request.decidedByUserId));
  const answered = requests.filter(
    (request) =>
      request.status === "decided" || request.status === "unanswered",
  );
  const latest =
    run.reason === "continuation" && run.previousTaskRunId
      ? answered
          .filter((request) => request.taskRunId === run.previousTaskRunId)
          .at(-1)
      : undefined;
  return {
    latest: latest ? textOf(latest) : null,
    decided: answered
      .filter((request) => request.status === "decided")
      .flatMap((request) => textOf(request) ?? []),
  };
};
