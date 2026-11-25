"use client";

import { useState, useTransition } from "react";
import {
  Avatar,
  Box,
  ButtonBase,
  CircularProgress,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Stack,
  Typography,
} from "@mui/material";
import CheckIcon from "@mui/icons-material/Check";
import type {
  ProjectMemberContract,
  WorkItemContract,
} from "@scarn/api/frontend-contracts";
import { parseUuidV7, parseWorkItemId } from "@scarn/api/frontend-contracts";
import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import { parseApiError } from "@/app/_lib/api-error";
import { getUserInitials } from "@/components/user-initials";
import {
  useHasProjectPermission,
  useIsProjectMember,
} from "@/components/project-route-context";
import { useProjectMembers } from "./use-project-members";

type MemberDisplay = Pick<ProjectMemberContract, "username" | "image">;

export const memberLabel = (member: MemberDisplay | undefined) =>
  member?.username ?? "Unknown member";

export function MemberAvatar({
  member,
}: {
  member: MemberDisplay | undefined;
}) {
  return (
    <Avatar
      src={member?.image ?? undefined}
      sx={{
        width: 20,
        height: 20,
        fontSize: 10,
        fontWeight: 600,
        bgcolor: "action.selected",
        color: "text.secondary",
      }}
    >
      {member?.image ? null : getUserInitials(member?.username ?? null, null)}
    </Avatar>
  );
}

function AssigneeValue({
  assigneeUserId,
  member,
}: {
  assigneeUserId: string | null;
  member: ProjectMemberContract | undefined;
}) {
  if (!assigneeUserId) {
    return (
      <Typography variant="body2" color="text.secondary">
        Unassigned
      </Typography>
    );
  }
  return (
    <Stack
      direction="row"
      spacing={0.75}
      alignItems="center"
      sx={{ minWidth: 0 }}
    >
      <MemberAvatar member={member} />
      <Typography
        variant="body2"
        sx={{
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {memberLabel(member)}
      </Typography>
    </Stack>
  );
}

/**
 * The Properties panel's Assignee value. A viewer who may update work items
 * gets a member picker (with "Unassigned" to clear); anyone else sees the
 * value read-only. Non-members can't list members, so they see only
 * "Assigned" or "Unassigned".
 */
export function WorkItemAssignee({
  projectId,
  workItem,
  onWorkItemChanged,
}: {
  projectId: string;
  workItem: WorkItemContract;
  onWorkItemChanged: (updated: WorkItemContract) => void;
}) {
  const isMember = useIsProjectMember();
  const canAssign = useHasProjectPermission("work-items:write") && isMember;
  const { members, error: membersError } = useProjectMembers(
    projectId,
    isMember,
  );
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [isPending, startAction] = useTransition();

  const assigneeUserId = workItem.assigneeUserId;
  const assignee = members.find((member) => member.userId === assigneeUserId);

  if (!isMember) {
    return (
      <Typography variant="body2" color="text.secondary">
        {assigneeUserId ? "Assigned" : "Unassigned"}
      </Typography>
    );
  }

  if (!canAssign) {
    return <AssigneeValue assigneeUserId={assigneeUserId} member={assignee} />;
  }

  const assign = (nextAssigneeUserId: string | null) => {
    setAnchor(null);
    if (nextAssigneeUserId === assigneeUserId) return;
    setActionError(null);
    startAction(async () => {
      const client = getBrowserScarnApiClient();
      const { data, error } = await client.api["work-items"]({
        workItemId: parseWorkItemId(workItem.id),
      }).patch({
        assigneeUserId:
          nextAssigneeUserId === null ? null : parseUuidV7(nextAssigneeUserId),
      });
      if (error) {
        setActionError(
          parseApiError(error, "Could not change assignee. Try again."),
        );
        return;
      }
      onWorkItemChanged(data);
    });
  };

  return (
    <Box>
      <ButtonBase
        aria-label="Change assignee"
        aria-haspopup="menu"
        aria-expanded={Boolean(anchor)}
        disabled={isPending}
        onClick={(event) => {
          setAnchor(event.currentTarget);
        }}
        sx={{
          borderRadius: 1,
          px: 0.5,
          mx: -0.5,
          maxWidth: "100%",
          justifyContent: "flex-start",
          "&:hover": { bgcolor: "action.hover" },
        }}
      >
        <AssigneeValue assigneeUserId={assigneeUserId} member={assignee} />
        {isPending ? <CircularProgress size={12} sx={{ ml: 0.75 }} /> : null}
      </ButtonBase>
      <Menu
        anchorEl={anchor}
        open={Boolean(anchor)}
        onClose={() => {
          setAnchor(null);
        }}
      >
        <MenuItem
          selected={assigneeUserId === null}
          onClick={() => {
            assign(null);
          }}
        >
          <ListItemIcon>
            {assigneeUserId === null ? <CheckIcon fontSize="small" /> : null}
          </ListItemIcon>
          <ListItemText>Unassigned</ListItemText>
        </MenuItem>
        {members.map((member) => (
          <MenuItem
            key={member.userId}
            selected={member.userId === assigneeUserId}
            onClick={() => {
              assign(member.userId);
            }}
          >
            <ListItemIcon>
              {member.userId === assigneeUserId ? (
                <CheckIcon fontSize="small" />
              ) : null}
            </ListItemIcon>
            <Stack direction="row" spacing={1} alignItems="center">
              <MemberAvatar member={member} />
              <ListItemText>{memberLabel(member)}</ListItemText>
            </Stack>
          </MenuItem>
        ))}
      </Menu>
      {(actionError ?? membersError) ? (
        <Typography variant="caption" color="error" sx={{ display: "block" }}>
          {actionError ?? membersError}
        </Typography>
      ) : null}
    </Box>
  );
}
