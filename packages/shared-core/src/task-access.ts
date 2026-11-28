import type { Grant } from "@scarn/sdk/definitions/steps";
import { grantSentence } from "@scarn/sdk/definitions/steps/work-item-features";
import type { GatheredTaskView } from "./gather-tasks";
import { ActionError, unwrapAction } from "./lib/action-error";
import type { TaskAccessClient } from "./lib/action-clients";
import type { TaskGrantRequest } from "./lib/task-api-types";

/**
 * A Task's access: the grants it holds, the agent's pending request for more,
 * and `scarn tasks access`, which approves all or some of that request or
 * denies it.
 */

/** How the CLI names a grant: `action:scope`, as `--only` takes it. */
export const grantSelector = (grant: Grant): string =>
  `${grant.action}:${grant.scope}`;

const labelsOf = (grant: Grant): readonly string[] | undefined =>
  "labels" in grant ? grant.labels : undefined;

function grantLine(grant: Grant): string {
  return `  ${grantSelector(grant).padEnd(17)} ${grantSentence(grant)}`;
}

export function pendingGrantRequest(
  requests: readonly TaskGrantRequest[],
): TaskGrantRequest | undefined {
  return requests.find((request) => request.status === "pending");
}

/** The `tasks view` lines for the Task's grants and any pending request. */
export function formatTaskAccess(gathered: GatheredTaskView): string[] {
  const { task, grantRequests } = gathered;
  const lines = [
    "",
    task.grants.length === 0 ? "Access: none" : "Access:",
    ...task.grants.map(grantLine),
  ];
  if (grantRequests.status === "unavailable") {
    lines.push(`Access requests: unavailable (${grantRequests.reason})`);
    return lines;
  }
  const pending = pendingGrantRequest(grantRequests.data);
  if (pending !== undefined) {
    lines.push(
      "",
      `The agent is asking for more access (request ${pending.id}):`,
      ...pending.reason.split("\n").map((line) => `  > ${line}`),
      ...pending.requested.map(grantLine),
    );
  }
  return lines;
}

export type AccessDecision =
  | { kind: "deny"; note?: string }
  | {
      kind: "approve";
      /** `action:scope` selectors; empty approves every requested grant. */
      only: readonly string[];
      /** Narrows the labels of the selected labelled grants; empty keeps them. */
      labels: readonly string[];
      note?: string;
    };

function narrowLabels(grant: Grant, labels: ReadonlySet<string>): Grant {
  const held = labelsOf(grant);
  if (held === undefined || labels.size === 0) return grant;
  const kept = held.filter((label) => labels.has(label));
  if (kept.length === 0) {
    throw new ActionError(
      "rejected",
      `--labels leaves ${grantSelector(grant)} with no labels; it asks for: ${held.join(", ")}.`,
    );
  }
  return { ...grant, labels: kept } as Grant;
}

/**
 * The grants to approve from `request`: those `--only` selects (all when
 * empty), with labels narrowed to `--labels`. Refuses a selector or label
 * the request doesn't have, before anything is sent.
 */
export function selectApproval(
  request: TaskGrantRequest,
  decision: Extract<AccessDecision, { kind: "approve" }>,
): Grant[] {
  const unknownSelectors = decision.only.filter(
    (selector) =>
      !request.requested.some((grant) => grantSelector(grant) === selector),
  );
  if (unknownSelectors.length > 0) {
    throw new ActionError(
      "rejected",
      `The request doesn't ask for ${unknownSelectors.join(", ")}; it asks for: ${request.requested.map(grantSelector).join(", ")}.`,
    );
  }
  const selected =
    decision.only.length === 0
      ? request.requested
      : request.requested.filter((grant) =>
          decision.only.includes(grantSelector(grant)),
        );
  const offered = new Set(selected.flatMap((grant) => labelsOf(grant) ?? []));
  const unknownLabels = decision.labels.filter((label) => !offered.has(label));
  if (unknownLabels.length > 0) {
    throw new ActionError(
      "rejected",
      `--labels must be labels the selected grants ask for (${[...offered].join(", ") || "none"}); got ${unknownLabels.join(", ")}.`,
    );
  }
  const labels = new Set(decision.labels);
  return selected.map((grant) => narrowLabels(grant, labels));
}

export type DecidedAccess = {
  taskId: string;
  grantRequestId: string;
  requested: Grant[];
  approved: Grant[];
};

/** Decides the Task's pending grant request; `action_conflict` when none is. */
export async function decideTaskAccess(options: {
  client: TaskAccessClient;
  taskId: string;
  decision: AccessDecision;
}): Promise<DecidedAccess> {
  const { client, taskId, decision } = options;
  const requests = unwrapAction(
    `load the access requests of Task ${taskId}`,
    await client.tasks.listTaskGrantRequests({ path: { taskId } }),
  );
  const pending = pendingGrantRequest(requests);
  if (pending === undefined) {
    throw new ActionError(
      "conflict",
      `Task ${taskId} has no pending access request.`,
    );
  }
  const approved =
    decision.kind === "deny" ? [] : selectApproval(pending, decision);
  unwrapAction(
    `decide the access request of Task ${taskId}`,
    await client.tasks.decideTaskGrantRequest({
      path: { grantRequestId: pending.id },
      body: {
        approved,
        ...(decision.note === undefined ? {} : { note: decision.note }),
      },
    }),
  );
  return {
    taskId,
    grantRequestId: pending.id,
    requested: pending.requested,
    approved,
  };
}
