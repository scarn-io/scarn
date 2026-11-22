"use client";

import { useState } from "react";
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  IconButton,
  InputAdornment,
  InputLabel,
  ListItemText,
  MenuItem,
  Radio,
  RadioGroup,
  Select,
  Stack,
  TextField,
  Typography,
  FormControlLabel,
} from "@mui/material";
import CheckIcon from "@mui/icons-material/Check";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import { parseApiError } from "@/app/_lib/api-error";
import type { ProjectInviteContract } from "@scarn/core/projects/project-invite/contracts/project-invite-contracts";
import { PROJECT_ROLES, type ProjectRole } from "@scarn/api/frontend-contracts";
import { projectRoleLabel } from "@/app/_lib/project-membership";

type InviteRestriction = ProjectInviteContract["restriction"];

type InviteCollaboratorDialogProps = {
  open: boolean;
  projectId: string;
  onClose: () => void;
  onInviteCreated: (inviteUrl: string, invite: ProjectInviteContract) => void;
};

type DialogPhase = "form" | "success";

export function InviteCollaboratorDialog({
  open,
  projectId,
  onClose,
  onInviteCreated,
}: InviteCollaboratorDialogProps) {
  const [phase, setPhase] = useState<DialogPhase>("form");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<ProjectRole | "">("");
  const [restriction, setRestriction] =
    useState<InviteRestriction>("specific_email");
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [inviteUrl, setInviteUrl] = useState("");
  const [copied, setCopied] = useState(false);

  const handleClose = () => {
    setPhase("form");
    setEmail("");
    setRole("");
    setRestriction("specific_email");
    setErrorMessage(null);
    setInviteUrl("");
    setCopied(false);
    onClose();
  };

  const handleSubmit = async () => {
    if (!role) return;
    setErrorMessage(null);
    setLoading(true);
    const client = getBrowserScarnApiClient();
    const payload =
      restriction === "specific_email"
        ? {
            email,
            role,
            restriction,
          }
        : {
            role,
            restriction,
          };
    const { data, error } = await client.api
      .projects({ projectId })
      .invites.post(payload);
    setLoading(false);

    if (error) {
      const message = parseApiError(
        error,
        "Could not create the invite. Try again.",
      );
      setErrorMessage(message);
      return;
    }

    const url = data.inviteUrl;
    setInviteUrl(url);
    setPhase("success");
    onInviteCreated(url, data.invite);
  };

  const isSpecificEmail = restriction === "specific_email";

  const handleCopy = () => {
    void navigator.clipboard.writeText(inviteUrl).then(() => {
      setCopied(true);
      setTimeout(() => {
        setCopied(false);
      }, 2000);
    });
  };

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
      <DialogTitle>Invite Collaborator</DialogTitle>
      {phase === "form" ? (
        <>
          <DialogContent>
            <Stack spacing={2} sx={{ pt: 1 }}>
              {errorMessage ? (
                <Alert severity="error">{errorMessage}</Alert>
              ) : null}
              <FormControl>
                <Typography variant="subtitle2" sx={{ mb: 1 }}>
                  Invite access
                </Typography>
                <RadioGroup
                  value={restriction}
                  onChange={(event) => {
                    setRestriction(event.target.value as InviteRestriction);
                  }}
                >
                  <FormControlLabel
                    value="specific_email"
                    control={<Radio />}
                    label="Restrict to a specific email"
                  />
                  <FormControlLabel
                    value="any_authenticated_user"
                    control={<Radio />}
                    label="Anyone with the link can claim it"
                  />
                </RadioGroup>
              </FormControl>
              {isSpecificEmail ? (
                <TextField
                  label="Email address"
                  type="email"
                  value={email}
                  onChange={(event) => {
                    setEmail(event.target.value);
                  }}
                  fullWidth
                  required
                  autoFocus
                />
              ) : (
                <Alert severity="info">
                  This link is single-use. The first signed-in user who accepts
                  it will join the project.
                </Alert>
              )}
              <FormControl fullWidth required>
                <InputLabel id="invite-role-label">Role</InputLabel>
                <Select
                  labelId="invite-role-label"
                  label="Role"
                  value={role}
                  onChange={(event) => {
                    setRole(event.target.value);
                  }}
                  renderValue={(value) => projectRoleLabel(value)}
                >
                  {PROJECT_ROLES.map((definition) => (
                    <MenuItem key={definition.name} value={definition.name}>
                      <ListItemText
                        primary={definition.label}
                        secondary={definition.description}
                        slotProps={{
                          secondary: { sx: { whiteSpace: "normal" } },
                        }}
                      />
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button onClick={handleClose}>Cancel</Button>
            <Button
              variant="contained"
              onClick={() => {
                void handleSubmit();
              }}
              loading={loading}
              disabled={!(isSpecificEmail ? email.trim() : true) || !role}
            >
              Send Invite
            </Button>
          </DialogActions>
        </>
      ) : (
        <>
          <DialogContent>
            <Stack spacing={2} sx={{ pt: 1 }}>
              <Typography variant="body2">
                Invite link created. Share this link with the intended
                collaborator.
              </Typography>
              <TextField
                label="Invite link"
                value={inviteUrl}
                fullWidth
                slotProps={{
                  input: {
                    readOnly: true,
                    endAdornment: (
                      <InputAdornment position="end">
                        <IconButton
                          aria-label={copied ? "Copied" : "Copy link"}
                          onClick={handleCopy}
                          edge="end"
                        >
                          {copied ? (
                            <CheckIcon color="success" />
                          ) : (
                            <ContentCopyIcon />
                          )}
                        </IconButton>
                      </InputAdornment>
                    ),
                  },
                }}
              />
              {copied ? (
                <Typography variant="caption" color="success.main">
                  Copied!
                </Typography>
              ) : null}
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button variant="contained" onClick={handleClose}>
              Close
            </Button>
          </DialogActions>
        </>
      )}
    </Dialog>
  );
}
