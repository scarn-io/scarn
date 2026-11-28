"use client";

import { useState } from "react";
import NextLink from "next/link";
import {
  Alert,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  IconButton,
  Link,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import CheckIcon from "@mui/icons-material/Check";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import LinkOffIcon from "@mui/icons-material/LinkOff";
import type {
  ArtifactShareStatus,
  ProjectArtifactShareContract,
} from "@scarn/api/frontend-contracts";
import { RecordList } from "@/components/common/record-list/record-list";
import { RecordListRow } from "@/components/common/record-list/record-list-row";
import { RecordListEmpty } from "@/components/common/record-list/record-list-empty";
import { useCopyToClipboard } from "@/components/common/copyable-command";
import { useHasProjectPermission } from "@/components/project-route-context";
import { artifactBundlePagePath } from "@/components/artifacts/artifact-page-path";
import { formatDateTime } from "@/components/executions/format-datetime";
import { useProjectArtifactShares } from "./use-project-artifact-shares";

const STATUS_LABELS: Partial<Record<ArtifactShareStatus, string>> = {
  shared: "Shared",
  expired: "Expired",
  unavailable: "Unavailable",
};

const CREATED_VIA_LABELS: Record<
  ProjectArtifactShareContract["createdVia"],
  string
> = {
  person: "Shared by a person",
  step: "Shared by a step",
};

function CopyShareLinkButton({ url, name }: { url: string; name: string }) {
  const { copied, copy } = useCopyToClipboard();

  return (
    <Tooltip title={copied ? "Copied" : "Copy link"}>
      <IconButton
        size="small"
        aria-label={
          copied
            ? `Copied share link for ${name}`
            : `Copy share link for ${name}`
        }
        onClick={() => {
          copy(url);
        }}
      >
        {copied ? (
          <CheckIcon fontSize="small" color="success" />
        ) : (
          <ContentCopyIcon fontSize="small" />
        )}
      </IconButton>
    </Tooltip>
  );
}

/**
 * Settings page "Active share links" section: every live share link in the
 * project (newest 50), including links that stopped working because their
 * bundle expired or sharing is off, so they can still be revoked. Revoke is
 * hidden for viewers lacking `executions:write`.
 */
export function ProjectArtifactSharesPanel({
  projectId,
  initialShares,
  initialHasMore,
}: {
  projectId: string;
  initialShares: ProjectArtifactShareContract[];
  initialHasMore: boolean;
}) {
  const canRevoke = useHasProjectPermission("executions:write");
  const { shares, hasMore, loading, error, revoke } = useProjectArtifactShares(
    projectId,
    initialShares,
    initialHasMore,
  );
  const [confirmShare, setConfirmShare] =
    useState<ProjectArtifactShareContract | null>(null);

  const handleConfirmRevoke = async () => {
    if (!confirmShare) return;
    await revoke(confirmShare);
    setConfirmShare(null);
  };

  return (
    <Stack spacing={1.5}>
      {error ? <Alert severity="error">{error}</Alert> : null}
      <RecordList title="Active share links" count={shares.length}>
        {shares.length === 0 ? (
          <RecordListEmpty
            title="No active share links."
            description="Links you or your steps share appear here until they're revoked."
          />
        ) : (
          shares.map((share, index) => (
            <RecordListRow
              key={share.id}
              isFirst={index === 0}
              primary={
                <Link
                  component={NextLink}
                  href={artifactBundlePagePath(projectId, share.bundleId)}
                  variant="body2"
                  sx={{
                    fontWeight: 600,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {share.bundleName}
                </Link>
              }
              secondary={
                <Typography variant="caption" color="text.secondary">
                  {`${CREATED_VIA_LABELS[share.createdVia]} · Created ${formatDateTime(share.createdAt)} · Expires ${formatDateTime(share.expiresAt)}`}
                </Typography>
              }
              trailing={
                <>
                  <Chip
                    size="small"
                    variant="outlined"
                    color={share.status === "shared" ? "success" : "default"}
                    label={STATUS_LABELS[share.status] ?? share.status}
                  />
                  {share.url ? (
                    <CopyShareLinkButton
                      url={share.url}
                      name={share.bundleName}
                    />
                  ) : null}
                  {canRevoke ? (
                    <IconButton
                      size="small"
                      color="error"
                      disabled={loading}
                      onClick={() => {
                        setConfirmShare(share);
                      }}
                      aria-label={`Revoke share link for ${share.bundleName}`}
                    >
                      <LinkOffIcon fontSize="small" />
                    </IconButton>
                  ) : null}
                </>
              }
            />
          ))
        )}
      </RecordList>
      {hasMore ? (
        <Typography variant="caption" color="text.secondary">
          Only the 50 newest share links are shown.
        </Typography>
      ) : null}
      <Dialog
        open={confirmShare !== null}
        onClose={() => {
          if (!loading) setConfirmShare(null);
        }}
      >
        <DialogTitle>Revoke share link?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {confirmShare
              ? `Anyone with the link to ${confirmShare.bundleName} will lose access. This can't be undone.`
              : ""}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => {
              setConfirmShare(null);
            }}
            disabled={loading}
          >
            Cancel
          </Button>
          <Button
            variant="contained"
            color="error"
            loading={loading}
            onClick={() => {
              void handleConfirmRevoke();
            }}
          >
            Revoke
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
