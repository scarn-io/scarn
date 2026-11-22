"use client";

import { useState, useTransition } from "react";
import {
  Alert,
  Avatar,
  Box,
  Button,
  IconButton,
  Link as MuiLink,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import type {
  WorkItemContract,
  WorkItemStatusSummaryContract,
} from "@scarn/api/frontend-contracts";
import { parseWorkItemId } from "@scarn/api/frontend-contracts";
import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import { apiErrorCode, parseApiError } from "@/app/_lib/api-error";
import {
  formatDateTime,
  formatRelativeTime,
} from "@/components/executions/format-datetime";
import { getUserInitials } from "@/components/user-initials";
import { WorkItemDescription } from "./work-item-description";
import { PlatformIcon, platformLabel } from "./work-item-platform";

const DESCRIPTION_CONFLICT_CODE = "WORK_ITEM_DESCRIPTION_CONFLICT";
const NO_KNOWN_WORK_ITEMS: readonly WorkItemStatusSummaryContract[] = [];

/**
 * The originating report — the customer's own voice — as the first entry of
 * the thread. It's deliberately distinct from team replies below it: a warm
 * accent rail marks it as the source signal (not chatter). No outer avatar
 * column — a small avatar sits inline next to the name in the card's own
 * header bar instead (matching `WorkItemCommentItem`), so this card stays
 * full-width and lines up with every other entry on the page (child work
 * items, comments, the composer).
 */
export function WorkItemBodyEntry({
  workItem,
  canEdit,
  onChanged,
  knownWorkItems = NO_KNOWN_WORK_ITEMS,
}: {
  workItem: WorkItemContract;
  /** Whether the current viewer may edit this post (author, native item). */
  canEdit: boolean;
  onChanged: (updated: WorkItemContract) => void;
  /**
   * Work items already loaded with their status, such as the children. The
   * description's links to them need no lookup.
   */
  knownWorkItems?: readonly WorkItemStatusSummaryContract[];
}) {
  const opened = workItem.sourceCreatedAt ?? workItem.createdAt;
  const isScarnCreator =
    workItem.platform === "scarn" && Boolean(workItem.createdByUsername);

  const [error, setError] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(workItem.title);
  const [editDescription, setEditDescription] = useState(workItem.description);
  const [editDescriptionVersion, setEditDescriptionVersion] = useState(
    workItem.descriptionVersion,
  );
  const [isPending, startTransition] = useTransition();

  const handleEditStart = () => {
    setEditTitle(workItem.title);
    setEditDescription(workItem.description);
    setEditDescriptionVersion(workItem.descriptionVersion);
    setError(null);
    setIsEditing(true);
  };

  const handleEditCancel = () => {
    setIsEditing(false);
    setEditTitle(workItem.title);
    setEditDescription(workItem.description);
    setError(null);
  };

  const handleEditSave = () => {
    setError(null);
    startTransition(async () => {
      const client = getBrowserScarnApiClient();
      const { data, error: err } = await client.api["work-items"]({
        workItemId: parseWorkItemId(workItem.id),
      }).patch({
        title: editTitle.trim(),
        description: editDescription.trim(),
        descriptionVersion: editDescriptionVersion,
      });
      if (err) {
        setError(
          apiErrorCode(err) === DESCRIPTION_CONFLICT_CODE
            ? "Changed since you opened it. Reload"
            : parseApiError(err, "Could not save changes. Try again."),
        );
        return;
      }
      onChanged(data);
      setIsEditing(false);
    });
  };

  const canSave = Boolean(editTitle.trim()) && Boolean(editDescription.trim());

  return (
    <Box
      sx={{
        position: "relative",
        minWidth: 0,
        border: 1,
        borderColor: "divider",
        borderRadius: 2,
        overflow: "hidden",
        backgroundColor: "background.paper",
        // Warm rail: this is the source signal, not a reply.
        "&::before": {
          content: '""',
          position: "absolute",
          top: 0,
          bottom: 0,
          left: 0,
          width: 3,
          backgroundColor: "var(--color-attention-fg)",
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
          backgroundColor: "action.hover",
        }}
      >
        {isScarnCreator ? (
          <Avatar
            src={workItem.createdByImage ?? undefined}
            sx={{
              width: 20,
              height: 20,
              fontSize: 10,
              fontWeight: 600,
              bgcolor: "action.selected",
              color: "text.secondary",
            }}
          >
            {workItem.createdByImage
              ? null
              : getUserInitials(workItem.createdByUsername, null)}
          </Avatar>
        ) : (
          <Avatar
            sx={{
              width: 20,
              height: 20,
              bgcolor:
                "color-mix(in srgb, var(--color-attention-fg) 18%, transparent)",
              color: "var(--color-attention-fg)",
              "& svg": { fontSize: 12 },
            }}
          >
            <PlatformIcon platform={workItem.platform} fontSize="inherit" />
          </Avatar>
        )}
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          {isScarnCreator ? workItem.createdByUsername : "Synced"}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          via {platformLabel(workItem.platform)}
        </Typography>
        {workItem.url ? (
          <MuiLink
            href={workItem.url}
            target="_blank"
            rel="noreferrer"
            variant="caption"
            underline="hover"
            sx={{ fontFamily: "var(--font-mono)" }}
          >
            {workItem.platformKey}
          </MuiLink>
        ) : (
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ fontFamily: "var(--font-mono)" }}
          >
            {workItem.platformKey}
          </Typography>
        )}
        <Tooltip title={formatDateTime(opened)}>
          <Typography variant="caption" color="text.secondary">
            · opened {formatRelativeTime(opened)}
          </Typography>
        </Tooltip>

        <Box sx={{ flexGrow: 1 }} />

        {canEdit && !isEditing ? (
          <Tooltip title="Edit">
            <span>
              <IconButton
                size="small"
                onClick={handleEditStart}
                disabled={isPending}
                aria-label="Edit post"
              >
                <EditOutlinedIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
        ) : null}
      </Stack>

      <Box sx={{ p: 1.75 }}>
        {error ? (
          <Alert severity="error" sx={{ mb: 1.5 }}>
            {error}
          </Alert>
        ) : null}
        {isEditing ? (
          <Stack spacing={1.5}>
            <TextField
              label="Title"
              fullWidth
              value={editTitle}
              onChange={(e) => {
                setEditTitle(e.target.value);
              }}
              disabled={isPending}
              autoFocus
            />
            <TextField
              label="Description"
              multiline
              minRows={3}
              fullWidth
              value={editDescription}
              onChange={(e) => {
                setEditDescription(e.target.value);
              }}
              disabled={isPending}
            />
            <Stack direction="row" spacing={1} justifyContent="flex-end">
              <Button
                size="small"
                onClick={handleEditCancel}
                disabled={isPending}
              >
                Cancel
              </Button>
              <Button
                size="small"
                variant="contained"
                onClick={handleEditSave}
                disabled={isPending || !canSave}
              >
                Save
              </Button>
            </Stack>
          </Stack>
        ) : workItem.description ? (
          <WorkItemDescription
            projectId={workItem.projectId}
            description={workItem.description}
            knownWorkItems={knownWorkItems}
          />
        ) : (
          <Typography variant="body2" color="text.secondary" fontStyle="italic">
            No description provided.
          </Typography>
        )}
      </Box>
    </Box>
  );
}
