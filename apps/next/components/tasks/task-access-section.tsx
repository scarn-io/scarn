"use client";

/**
 * The Task page's "Access" section: every work item grant the Task holds,
 * each with where it came from: its step, always (reading its own item), or
 * a person's approval of the agent's request.
 */

import { useEffect, useState } from "react";
import { Box, Stack, Typography } from "@mui/material";
import { grantKey, type Grant } from "@scarn/core/tasks/task/domain/grants";
import { formatDateTime } from "@/components/executions/format-datetime";
import { useIsProjectMember } from "@/components/project-route-context";
import { useProjectMembers } from "@/components/work-items/use-project-members";
import { GrantSentence } from "@/components/conversations/grant-request-card";
import {
  fetchTaskGrantRequests,
  type GrantRequest,
} from "@/components/conversations/grant-request-api";
import type { TaskDetail } from "./task-api";

type Approval = { userId: string | null; at: string | null };

/** Where a held grant came from, one entry per source, step first. */
export type GrantOrigin =
  { kind: "step" } | { kind: "always" } | ({ kind: "approved" } & Approval);

const labelsOf = (grant: Grant): readonly string[] | undefined =>
  "labels" in grant ? grant.labels : undefined;

/**
 * Where each of `grants` came from. `read` on the item itself is always
 * held. A grant a decided request approved is marked with that approval; it
 * is also from the step when the step holds labels no approval added.
 */
export function grantOrigins(
  grants: readonly Grant[],
  requests: readonly GrantRequest[],
): GrantOrigin[][] {
  const decided = requests.filter((request) => request.status === "decided");
  return grants.map((grant) => {
    if (grant.action === "read" && grant.scope === "self") {
      return [{ kind: "always" }];
    }
    const key = grantKey(grant);
    const approvals = decided.flatMap((request) =>
      (request.approved ?? [])
        .filter((approved) => grantKey(approved) === key)
        .map((approved) => ({
          approved,
          approval: { userId: request.decidedByUserId, at: request.decidedAt },
        })),
    );
    if (approvals.length === 0) return [{ kind: "step" }];
    const held = labelsOf(grant);
    const approvedLabels = new Set(
      approvals.flatMap(({ approved }) => labelsOf(approved) ?? []),
    );
    const fromStep =
      held !== undefined && held.some((label) => !approvedLabels.has(label));
    return [
      ...(fromStep ? [{ kind: "step" } as const] : []),
      ...approvals.map(({ approval }) => ({
        kind: "approved" as const,
        ...approval,
      })),
    ];
  });
}

function originText(
  origin: GrantOrigin,
  stepName: string | null,
  usernames: ReadonlyMap<string, string | null>,
): string {
  switch (origin.kind) {
    case "always":
      return "Always";
    case "step":
      return stepName ? `From step ${stepName}` : "From the Task";
    case "approved": {
      const name =
        (origin.userId ? usernames.get(origin.userId) : null) ?? "someone";
      return `Approved by ${name}, ${formatDateTime(origin.at)}`;
    }
  }
}

export function TaskAccessList({
  grants,
  requests,
  stepName,
  usernames,
}: {
  grants: readonly Grant[];
  requests: readonly GrantRequest[];
  stepName: string | null;
  usernames: ReadonlyMap<string, string | null>;
}) {
  const origins = grantOrigins(grants, requests);
  return (
    <Stack component="ul" spacing={0.75} sx={{ m: 0, p: 0, listStyle: "none" }}>
      {grants.map((grant, index) => (
        <Box
          component="li"
          key={grantKey(grant)}
          data-testid="task-access-grant"
        >
          <Typography variant="body2">
            <GrantSentence grant={grant} />
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {(origins[index] ?? [])
              .map((origin) => originText(origin, stepName, usernames))
              .join(" · ")}
          </Typography>
        </Box>
      ))}
    </Stack>
  );
}

/** The section on the Task page; renders nothing for a Task with no grants. */
export function TaskAccessSection({ task }: { task: TaskDetail }) {
  const isMember = useIsProjectMember();
  const hasGrants = task.grants.length > 0;
  const { members } = useProjectMembers(task.projectId, isMember && hasGrants);
  const [requests, setRequests] = useState<GrantRequest[]>([]);

  useEffect(() => {
    if (!hasGrants) return;
    let cancelled = false;
    fetchTaskGrantRequests(task.id).then(
      (loaded) => {
        if (!cancelled) setRequests(loaded);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [task.id, task.updatedAt, hasGrants]);

  if (!hasGrants) return null;
  const usernames = new Map(
    members.map((member) => [member.userId as string, member.username]),
  );
  return (
    <Box component="section" aria-label="Access" data-testid="task-access">
      <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 0.75 }}>
        Access
      </Typography>
      <TaskAccessList
        grants={task.grants}
        requests={requests}
        stepName={
          task.source.kind === "step_definition" ? task.source.name : null
        }
        usernames={usernames}
      />
    </Box>
  );
}
