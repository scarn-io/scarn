"use client";

import { useState } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  IconButton,
  Paper,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import CheckIcon from "@mui/icons-material/Check";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import type {
  ArtifactShareContract,
  ArtifactShareStatus,
} from "@scarn/api/frontend-contracts";
import { useCopyToClipboard } from "@/components/common/copyable-command";

const STATUS_LABELS: Record<ArtifactShareStatus, string> = {
  private: "Private",
  shared: "Shared",
  expired: "Expired",
  deleted: "Deleted",
  unavailable: "Unavailable",
};

export const BUNDLE_EXPIRED_SHARE_MESSAGE =
  "This bundle has expired, so it can't be shared.";
export const BUNDLE_DELETED_SHARE_MESSAGE =
  "This bundle was deleted, so it can't be shared.";
export const SHARING_OFF_MESSAGE = "Sharing is off on this server.";
export const SHARING_OFF_DECLARED_MESSAGE =
  "This bundle would be shared; sharing is off on this server.";

/** The warning shown next to an active share link. */
export const shareWarning = (expiresAt: string) =>
  `Anyone with this link can view this bundle. It expires on ${new Date(expiresAt).toLocaleString()}.`;

function CopyLinkButton({ url }: { url: string }) {
  const { copied, copy } = useCopyToClipboard();

  return (
    <Tooltip title={copied ? "Copied" : "Copy"}>
      <IconButton
        size="small"
        aria-label={copied ? "Copied share link" : "Copy share link"}
        onClick={() => {
          copy(url);
        }}
      >
        {copied ? (
          <CheckIcon fontSize="inherit" color="success" />
        ) : (
          <ContentCopyIcon fontSize="inherit" />
        )}
      </IconButton>
    </Tooltip>
  );
}

/**
 * A bundle's share state: private (with a Share button), shared (the link,
 * a copy button, the public-access warning and a confirmed "Revoke link"),
 * expired, deleted, or unavailable when sharing is off on this server.
 * `canManage: false` hides the Share and Revoke buttons.
 */
export function ArtifactSharePanel({
  share,
  busy,
  error,
  canManage = true,
  onShare,
  onRevoke,
}: {
  share: ArtifactShareContract;
  busy: boolean;
  error: string;
  canManage?: boolean;
  onShare: () => Promise<unknown>;
  onRevoke: () => Promise<unknown>;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);

  const handleRevoke = async () => {
    await onRevoke();
    setConfirmOpen(false);
  };

  return (
    <Paper
      variant="outlined"
      sx={{ p: 2 }}
      component="section"
      aria-label="Share link"
    >
      <Stack spacing={1.5}>
        <Stack direction="row" spacing={1} alignItems="center">
          <Typography variant="subtitle2">Share link</Typography>
          <Chip
            size="small"
            variant="outlined"
            label={STATUS_LABELS[share.status]}
          />
        </Stack>
        {share.status === "private" ? (
          <Stack
            direction="row"
            spacing={2}
            alignItems="center"
            justifyContent="space-between"
          >
            <Typography variant="body2" color="text.secondary">
              Only project members can view this bundle.
            </Typography>
            {canManage ? (
              <Button
                variant="contained"
                size="small"
                loading={busy}
                onClick={() => {
                  void onShare();
                }}
              >
                Share
              </Button>
            ) : null}
          </Stack>
        ) : null}
        {share.status === "shared" && share.url ? (
          <>
            <Stack direction="row" spacing={0.5} alignItems="center">
              <Box
                component="span"
                sx={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "0.75rem",
                  wordBreak: "break-all",
                }}
              >
                {share.url}
              </Box>
              <CopyLinkButton url={share.url} />
            </Stack>
            <Alert severity="warning">{shareWarning(share.expiresAt)}</Alert>
            {canManage ? (
              <Box>
                <Button
                  variant="outlined"
                  color="error"
                  size="small"
                  disabled={busy}
                  onClick={() => {
                    setConfirmOpen(true);
                  }}
                >
                  Revoke link
                </Button>
              </Box>
            ) : null}
          </>
        ) : null}
        {share.status === "expired" ? (
          <Typography variant="body2" color="text.secondary">
            {BUNDLE_EXPIRED_SHARE_MESSAGE}
          </Typography>
        ) : null}
        {share.status === "deleted" ? (
          <Typography variant="body2" color="text.secondary">
            {BUNDLE_DELETED_SHARE_MESSAGE}
          </Typography>
        ) : null}
        {share.status === "unavailable" ? (
          <Typography variant="body2" color="text.secondary">
            {share.shareDeclared
              ? SHARING_OFF_DECLARED_MESSAGE
              : SHARING_OFF_MESSAGE}
          </Typography>
        ) : null}
        {error ? (
          <Alert severity="error" role="alert">
            {error}
          </Alert>
        ) : null}
      </Stack>
      <Dialog
        open={confirmOpen}
        onClose={() => {
          if (!busy) setConfirmOpen(false);
        }}
      >
        <DialogTitle>Revoke this link?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Anyone using the link loses access right away.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => {
              setConfirmOpen(false);
            }}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            variant="contained"
            color="error"
            loading={busy}
            onClick={() => {
              void handleRevoke();
            }}
          >
            Revoke link
          </Button>
        </DialogActions>
      </Dialog>
    </Paper>
  );
}
