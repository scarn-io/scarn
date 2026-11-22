"use client";

import { useState, useTransition } from "react";
import {
  Alert,
  Avatar,
  Button,
  Card,
  CardContent,
  Chip,
  IconButton,
  InputAdornment,
  List,
  ListItem,
  ListItemAvatar,
  ListItemText,
  MenuItem,
  Select,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import CheckIcon from "@mui/icons-material/Check";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import DeleteIcon from "@mui/icons-material/Delete";
import PersonAddAltOutlinedIcon from "@mui/icons-material/PersonAddAltOutlined";
import type { ProjectInviteContract } from "@scarn/core/projects/project-invite/contracts/project-invite-contracts";
import {
  PROJECT_ROLES,
  type ProjectMemberContract,
  type ProjectRole,
  type UuidV7,
} from "@scarn/api/frontend-contracts";
import { projectRoleLabel } from "@/app/_lib/project-membership";
import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import { parseApiError } from "@/app/_lib/api-error";
import { RecordListEmpty } from "@/components/common/record-list/record-list-empty";
import { useHasProjectPermission } from "@/components/project-route-context";
import { InviteCollaboratorDialog } from "./invite-collaborator-dialog";

type ProjectCollaboratorsPanelProps = {
  projectId: string;
  initialMembers: ProjectMemberContract[];
  initialInvites: ProjectInviteContract[];
};

export function ProjectCollaboratorsPanel({
  projectId,
  initialMembers,
  initialInvites,
}: ProjectCollaboratorsPanelProps) {
  const canManage = useHasProjectPermission("members:write");
  const [members, setMembers] = useState(initialMembers);
  const [updatingMemberId, setUpdatingMemberId] = useState<string | null>(null);
  const [invites, setInvites] = useState(initialInvites);
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);
  const [successUrl, setSuccessUrl] = useState<string | null>(null);
  const [successCopied, setSuccessCopied] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [confirmRevokeId, setConfirmRevokeId] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const handleInviteCreated = (
    inviteUrl: string,
    invite: ProjectInviteContract,
  ) => {
    setSuccessUrl(inviteUrl);
    setSuccessCopied(false);
    setInvites((current) => [...current, invite]);
  };

  const getInviteAudienceLabel = (invite: ProjectInviteContract) =>
    invite.restriction === "specific_email"
      ? invite.email
      : "Any authenticated user";

  const handleCopySuccess = () => {
    if (!successUrl) return;
    void navigator.clipboard.writeText(successUrl).then(() => {
      setSuccessCopied(true);
      setTimeout(() => {
        setSuccessCopied(false);
      }, 2000);
    });
  };

  const handleRevoke = (inviteId: string) => {
    setErrorMessage(null);
    startTransition(async () => {
      const client = getBrowserScarnApiClient();
      const { error } = await client.api
        .projects({ projectId })
        .invites({ inviteId })
        .revoke.post();
      if (error) {
        setErrorMessage(
          parseApiError(error, "Could not revoke the invite. Try again."),
        );
        setConfirmRevokeId(null);
        return;
      }
      setInvites((current) => current.filter((inv) => inv.id !== inviteId));
      setConfirmRevokeId(null);
    });
  };

  const handleRoleChange = async (userId: UuidV7, role: ProjectRole) => {
    setErrorMessage(null);
    setUpdatingMemberId(userId);
    const client = getBrowserScarnApiClient();
    const { data, error } = await client.api
      .projects({ projectId })
      .members({ userId })
      .role.put({ role });
    setUpdatingMemberId(null);
    if (error) {
      setErrorMessage(
        parseApiError(error, "Could not change the member's role. Try again."),
      );
      return;
    }
    setMembers((current) =>
      current.map((member) =>
        member.userId === userId
          ? { ...member, role: data.role, permissions: data.permissions }
          : member,
      ),
    );
  };

  const roleColor = (role: string): "default" | "primary" | "secondary" => {
    if (role === "admin") return "primary";
    if (role === "write") return "secondary";
    return "default";
  };

  if (!canManage) {
    return (
      <Alert severity="info">
        Only project admins can invite collaborators.
      </Alert>
    );
  }

  return (
    <Stack spacing={2}>
      {errorMessage ? <Alert severity="error">{errorMessage}</Alert> : null}

      {successUrl ? (
        <Alert
          severity="success"
          onClose={() => {
            setSuccessUrl(null);
          }}
        >
          <Stack spacing={1}>
            <Typography variant="body2">
              Invite created. Share this link with the collaborator.
            </Typography>
            <TextField
              size="small"
              value={successUrl}
              slotProps={{
                input: {
                  readOnly: true,
                  endAdornment: (
                    <InputAdornment position="end">
                      <IconButton
                        aria-label={successCopied ? "Copied" : "Copy link"}
                        onClick={handleCopySuccess}
                        edge="end"
                        size="small"
                      >
                        {successCopied ? (
                          <CheckIcon fontSize="small" color="success" />
                        ) : (
                          <ContentCopyIcon fontSize="small" />
                        )}
                      </IconButton>
                    </InputAdornment>
                  ),
                },
              }}
              fullWidth
            />
          </Stack>
        </Alert>
      ) : null}

      <Card variant="outlined">
        <List disablePadding aria-label="Project members">
          {members.map((member, index) => (
            <ListItem
              key={member.userId}
              divider={index < members.length - 1}
              secondaryAction={
                <Select
                  size="small"
                  value={member.role}
                  disabled={updatingMemberId === member.userId}
                  onChange={(event) => {
                    void handleRoleChange(
                      member.userId,
                      event.target.value as ProjectRole,
                    );
                  }}
                  renderValue={(value) => projectRoleLabel(value)}
                  slotProps={{
                    input: {
                      "aria-label": `Role for ${member.username ?? "member"}`,
                    },
                  }}
                  sx={{ minWidth: 120 }}
                >
                  {PROJECT_ROLES.map((definition) => (
                    <MenuItem key={definition.name} value={definition.name}>
                      <ListItemText
                        primary={definition.label}
                        secondary={definition.description}
                        slotProps={{
                          secondary: {
                            sx: { whiteSpace: "normal", maxWidth: 320 },
                          },
                        }}
                      />
                    </MenuItem>
                  ))}
                </Select>
              }
            >
              <ListItemAvatar>
                <Avatar src={member.image ?? undefined} />
              </ListItemAvatar>
              <ListItemText primary={member.username ?? "Unknown user"} />
            </ListItem>
          ))}
        </List>
      </Card>

      <Stack direction="row" spacing={1} justifyContent="flex-end">
        <Button
          variant="contained"
          onClick={() => {
            setInviteDialogOpen(true);
          }}
        >
          Invite Collaborator
        </Button>
      </Stack>

      {invites.length === 0 ? (
        <Card variant="outlined">
          <RecordListEmpty
            icon={<PersonAddAltOutlinedIcon fontSize="medium" />}
            title="No pending invites"
            description="Invite teammates to collaborate on this project. Pending invites will appear here and can be revoked at any time."
            action={
              <Button
                variant="contained"
                color="primary"
                onClick={() => {
                  setInviteDialogOpen(true);
                }}
              >
                Invite Collaborator
              </Button>
            }
          />
        </Card>
      ) : (
        <Stack spacing={1.5}>
          {invites.map((invite) => (
            <Card key={invite.id} variant="outlined">
              <CardContent>
                <Stack
                  direction={{ xs: "column", md: "row" }}
                  spacing={2}
                  justifyContent="space-between"
                  alignItems={{ md: "center" }}
                >
                  <Stack spacing={0.75}>
                    <Stack direction="row" spacing={1} alignItems="center">
                      <Typography variant="subtitle1">
                        {getInviteAudienceLabel(invite)}
                      </Typography>
                      <Chip
                        size="small"
                        color={roleColor(invite.role)}
                        label={projectRoleLabel(invite.role)}
                        variant="outlined"
                      />
                      <Chip
                        size="small"
                        label={
                          invite.restriction === "specific_email"
                            ? "Restricted"
                            : "Claimable link"
                        }
                        variant="outlined"
                      />
                    </Stack>
                    <Typography variant="caption" color="text.secondary">
                      Expires {new Date(invite.expiresAt).toLocaleDateString()}
                    </Typography>
                  </Stack>
                  <Stack direction="row" spacing={1} alignItems="center">
                    {confirmRevokeId === invite.id ? (
                      <>
                        <Typography variant="body2" color="text.secondary">
                          Are you sure?
                        </Typography>
                        <Button
                          size="small"
                          color="error"
                          variant="contained"
                          onClick={() => {
                            handleRevoke(invite.id);
                          }}
                          disabled={isPending}
                        >
                          Revoke
                        </Button>
                        <Button
                          size="small"
                          onClick={() => {
                            setConfirmRevokeId(null);
                          }}
                          disabled={isPending}
                        >
                          Cancel
                        </Button>
                      </>
                    ) : (
                      <IconButton
                        aria-label="Revoke invite"
                        color="error"
                        onClick={() => {
                          setConfirmRevokeId(invite.id);
                        }}
                        disabled={isPending}
                      >
                        <DeleteIcon />
                      </IconButton>
                    )}
                  </Stack>
                </Stack>
              </CardContent>
            </Card>
          ))}
        </Stack>
      )}

      <InviteCollaboratorDialog
        open={inviteDialogOpen}
        projectId={projectId}
        onClose={() => {
          setInviteDialogOpen(false);
        }}
        onInviteCreated={(url, invite) => {
          handleInviteCreated(url, invite);
        }}
      />
    </Stack>
  );
}
