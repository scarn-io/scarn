"use client";

import { useState, useTransition } from "react";
import {
  Alert,
  Box,
  Button,
  Stack,
  TextField,
  Tooltip,
  Typography,
  alpha,
} from "@mui/material";
import PendingActionsIcon from "@mui/icons-material/PendingActions";
import type {
  PendingCommentDraftContract,
  WorkItemCommentContract,
  WorkItemContract,
} from "@scarn/api/frontend-contracts";
import { parseUuidV7 } from "@scarn/api/frontend-contracts";
import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import { apiErrorCode, parseApiError } from "@/app/_lib/api-error";
import type { IntegrationCredentialChoice } from "@scarn/core/secrets/secret/contracts/secret-contracts";
import {
  CREDENTIAL_PLATFORMS,
  type CredentialPlatform,
} from "@/components/integrations/credential-platforms";
import { IntegrationCredentialDialog } from "@/components/integrations/integration-credential-dialog";
import { formatAbsoluteTime, formatRelativeTime } from "./comment-presentation";
import {
  CommentDraftBodyPreview,
  hasArtifactMarkers,
} from "./comment-draft-artifact-preview";
import {
  ArtifactApprovalBlockedBanner,
  ArtifactLeftOutPanel,
  unavailableArtifactMarkers,
  type UnavailableArtifactMarker,
} from "./comment-draft-artifact-notices";

type WorkItemPlatform = WorkItemContract["platform"];

/**
 * A pending `comment_draft` notification, rendered as an action item awaiting
 * a human decision (Decision 13 — grouped above the settled comment thread,
 * not interleaved by `createdAt`). Unlike `WorkItemCommentItem`, the body is
 * always a live, editable field rather than a separate edit mode: there's no
 * "as posted" state yet to protect until Approve is clicked.
 */
export function WorkItemCommentDraftItem({
  draft,
  workItemPlatform,
  onApproved,
  onRejected,
}: {
  draft: PendingCommentDraftContract;
  workItemPlatform: WorkItemPlatform;
  onApproved: (comment: WorkItemCommentContract) => void;
  onRejected: (notificationId: string) => void;
}) {
  const [editedBody, setEditedBody] = useState(draft.notification.body);
  const [error, setError] = useState<string | null>(draft.lastError);
  const [blockedMarkers, setBlockedMarkers] = useState<
    UnavailableArtifactMarker[] | null
  >(null);
  const [isPending, startTransition] = useTransition();
  const leftOut = draft.artifactResolution?.leftOut ?? [];
  const showPreview = hasArtifactMarkers(editedBody);
  const [credentialPlatform, setCredentialPlatform] =
    useState<CredentialPlatform | null>(null);

  const approve = (credential?: IntegrationCredentialChoice) => {
    setError(null);
    setBlockedMarkers(null);
    startTransition(async () => {
      const client = getBrowserScarnApiClient();
      const { data, error: err } = await client.api["work-item-comment-drafts"](
        {
          notificationId: parseUuidV7(draft.notification.id),
        },
      ).approve.post({
        body: editedBody.trim(),
        ...(credential ? { credential } : {}),
      });
      if (err) {
        if (!credential && apiErrorCode(err) === "GITHUB_TOKEN_REQUIRED") {
          setCredentialPlatform("github");
          return;
        }
        const unavailable = unavailableArtifactMarkers(err);
        if (unavailable) {
          setBlockedMarkers(unavailable);
          return;
        }
        setError(
          parseApiError(err, "Could not approve this comment. Try again."),
        );
        return;
      }
      onApproved(data);
    });
  };

  const handleApprove = () => {
    if (workItemPlatform === "jira" || workItemPlatform === "bitbucket") {
      setCredentialPlatform(workItemPlatform);
      return;
    }
    approve();
  };

  const handleCredentialConfirm = (credential: IntegrationCredentialChoice) => {
    setCredentialPlatform(null);
    approve(credential);
  };

  const handleReject = () => {
    setError(null);
    startTransition(async () => {
      const client = getBrowserScarnApiClient();
      const { error: err } = await client.api["work-item-comment-drafts"]({
        notificationId: parseUuidV7(draft.notification.id),
      }).reject.post(undefined);
      if (err) {
        setError(
          parseApiError(err, "Could not reject this comment. Try again."),
        );
        return;
      }
      onRejected(draft.notification.id);
    });
  };

  return (
    <>
      <Box
        sx={{
          position: "relative",
          minWidth: 0,
          border: 1,
          borderColor: "warning.main",
          borderRadius: 2,
          overflow: "hidden",
          backgroundColor: "background.paper",
          boxShadow: (theme) =>
            `0 0 0 1px ${alpha(theme.palette.warning.main, 0.3)}, 0 8px 24px ${alpha(theme.palette.warning.main, 0.08)}`,
          // Warning-toned spine on the left edge, distinguishing an
          // awaiting-approval draft from a pinned comment's cyan spine.
          "&::before": {
            content: '""',
            position: "absolute",
            top: 0,
            bottom: 0,
            left: 0,
            width: 3,
            backgroundColor: "warning.main",
          },
        }}
      >
        <Stack
          direction="row"
          alignItems="center"
          spacing={1}
          sx={{
            px: 1.5,
            py: 0.75,
            borderBottom: 1,
            borderColor: "divider",
            backgroundColor: (theme) => alpha(theme.palette.warning.main, 0.08),
          }}
        >
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            Agent-drafted comment
          </Typography>
          <Tooltip title={formatAbsoluteTime(draft.notification.createdAt)}>
            <Typography variant="caption" color="text.secondary">
              drafted {formatRelativeTime(draft.notification.createdAt)}
            </Typography>
          </Tooltip>

          <Stack
            direction="row"
            spacing={0.5}
            alignItems="center"
            sx={{ color: "warning.main" }}
          >
            <PendingActionsIcon sx={{ fontSize: 14 }} />
            <Typography
              variant="caption"
              sx={{ fontWeight: 700, letterSpacing: "0.01em" }}
            >
              Awaiting approval
            </Typography>
          </Stack>

          <Box sx={{ flexGrow: 1 }} />
        </Stack>

        <Box sx={{ p: 1.5 }}>
          <Stack spacing={1}>
            {error ? <Alert severity="error">{error}</Alert> : null}
            {blockedMarkers ? (
              <ArtifactApprovalBlockedBanner markers={blockedMarkers} />
            ) : null}
            <Stack direction={{ xs: "column", md: "row" }} spacing={1.5}>
              <Stack spacing={1.5} sx={{ flex: 1, minWidth: 0 }}>
                <TextField
                  multiline
                  minRows={3}
                  fullWidth
                  value={editedBody}
                  onChange={(e) => {
                    setEditedBody(e.target.value);
                  }}
                  disabled={isPending}
                />
                {showPreview ? (
                  <CommentDraftBodyPreview
                    body={editedBody}
                    projectId={draft.notification.projectId}
                    resolution={draft.artifactResolution}
                  />
                ) : null}
              </Stack>
              {leftOut.length > 0 ? (
                <Box sx={{ width: { xs: "100%", md: 240 }, flexShrink: 0 }}>
                  <ArtifactLeftOutPanel leftOut={leftOut} />
                </Box>
              ) : null}
            </Stack>
            <Stack direction="row" spacing={1} justifyContent="flex-end">
              <Button
                size="small"
                variant="outlined"
                onClick={handleReject}
                disabled={isPending}
              >
                Reject
              </Button>
              <Button
                size="small"
                variant="contained"
                onClick={handleApprove}
                disabled={isPending || !editedBody.trim()}
              >
                Approve
              </Button>
            </Stack>
          </Stack>
        </Box>
      </Box>
      <IntegrationCredentialDialog
        platform={credentialPlatform ?? "jira"}
        open={credentialPlatform !== null}
        onClose={() => {
          setCredentialPlatform(null);
        }}
        onConfirm={handleCredentialConfirm}
        title={`Post comment to ${CREDENTIAL_PLATFORMS[credentialPlatform ?? "jira"].label}`}
        description={
          credentialPlatform === "github"
            ? "This project connects GitHub with your token. Choose which token posts the comment."
            : undefined
        }
        confirmLabel="Approve & post"
      />
    </>
  );
}
