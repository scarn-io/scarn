import {
  createUuidV7,
  type UuidV7,
} from "@scarn/core/common/contracts/uuid-v7";
import { grantKey, type Grant } from "@scarn/core/tasks/task/domain/grants";

/**
 * A Task's agent asking a person for more grants when it hands over. A
 * person approves all, some or none of them; the approved grants are added
 * to the Task's own grants, never its step's. A Task has at most one
 * `pending` request.
 *
 * - `pending`: waiting for a person.
 * - `decided`: a person approved `approved` (`[]` is a deny).
 * - `unanswered`: a person replied or continued without deciding.
 * - `withdrawn`: the Task was cancelled while the request was pending.
 *
 * See docs/plans/agent-grant-requests.md.
 */
export const grantRequestStatusValues = [
  "pending",
  "decided",
  "unanswered",
  "withdrawn",
] as const;

export type GrantRequestStatus = (typeof grantRequestStatusValues)[number];

export type GrantRequest = {
  id: UuidV7;
  projectId: UuidV7;
  taskId: UuidV7;
  /** The run that handed over with the request. */
  taskRunId: UuidV7;
  reason: string;
  requested: Grant[];
  status: GrantRequestStatus;
  /** Null until decided; `[]` is a deny. */
  approved: Grant[] | null;
  note: string | null;
  decidedByUserId: UuidV7 | null;
  decidedAt: Date | null;
  createdAt: Date;
};

/** A new `pending` request from the run `taskRunId` of Task `taskId`. */
export const newGrantRequest = (props: {
  id?: UuidV7 | undefined;
  projectId: UuidV7;
  taskId: UuidV7;
  taskRunId: UuidV7;
  reason: string;
  requested: readonly Grant[];
  now: Date;
}): GrantRequest => ({
  id: props.id ?? createUuidV7(),
  projectId: props.projectId,
  taskId: props.taskId,
  taskRunId: props.taskRunId,
  reason: props.reason,
  requested: props.requested.map((grant) => ({ ...grant })),
  status: "pending",
  approved: null,
  note: null,
  decidedByUserId: null,
  decidedAt: null,
  createdAt: props.now,
});

const sameGrant = (left: Grant, right: Grant) =>
  grantKey(left) === grantKey(right);

const labelsOf = (grant: Grant): readonly string[] | undefined =>
  "labels" in grant ? grant.labels : undefined;

/**
 * Whether `requested` covers `approved`: same action, scope and `keyPrefix`,
 * and labels a subset of the requested ones. A grant naming no labels
 * covers any, so it only covers an approval that names none or some.
 */
const covers = (requested: Grant, approved: Grant): boolean => {
  if (!sameGrant(requested, approved)) {
    return false;
  }
  const asked = labelsOf(requested);
  const given = labelsOf(approved);
  if (asked === undefined) {
    return true;
  }
  return given !== undefined && given.every((label) => asked.includes(label));
};

/** Why `approved` isn't part of `request`, one message per grant; empty when it is. */
export const approvalRefusals = (
  request: GrantRequest,
  approved: readonly Grant[],
): string[] =>
  approved.flatMap((grant) =>
    request.requested.some((asked) => covers(asked, grant))
      ? []
      : [
          `${grant.action} on ${grant.scope}${"keyPrefix" in grant && grant.keyPrefix ? ` (key prefix ${grant.keyPrefix})` : ""} isn't covered by a requested grant`,
        ],
  );

/**
 * How many of the requested grants the decision approved; one approved with
 * fewer labels than asked still counts.
 */
export const approvedCount = (request: GrantRequest): number =>
  request.requested.filter((asked) =>
    (request.approved ?? []).some((grant) => sameGrant(asked, grant)),
  ).length;

/**
 * `request` decided by `userId` at `now`: `approved` (`[]` denies) with an
 * optional note. Only a `pending` request can be decided; the caller checks
 * `approvalRefusals` first.
 */
export const decideGrantRequest = (
  request: GrantRequest,
  decision: {
    approved: readonly Grant[];
    note: string | null;
    userId: UuidV7;
    now: Date;
  },
): GrantRequest => ({
  ...request,
  status: "decided",
  approved: decision.approved.map((grant) => ({ ...grant })),
  note: decision.note,
  decidedByUserId: decision.userId,
  decidedAt: decision.now,
});

/** `request` closed without a decision: a person replied or continued. */
export const markGrantRequestUnanswered = (
  request: GrantRequest,
): GrantRequest => ({ ...request, status: "unanswered" });

/** `request` closed because its Task was cancelled. */
export const withdrawGrantRequest = (request: GrantRequest): GrantRequest => ({
  ...request,
  status: "withdrawn",
});
