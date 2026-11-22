"use client";

import { useState, useTransition, type ReactNode } from "react";
import Link from "next/link";
import {
  Alert,
  Avatar,
  Box,
  Button,
  Chip,
  IconButton,
  Link as MuiLink,
  Menu,
  MenuItem,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import MoreHorizIcon from "@mui/icons-material/MoreHoriz";
import BoltIcon from "@mui/icons-material/Bolt";
import BoltOutlinedIcon from "@mui/icons-material/BoltOutlined";
import type {
  WorkItemCommentContract,
  WorkItemQuestionContract,
} from "@scarn/api/frontend-contracts";
import { parseUuidV7 } from "@scarn/api/frontend-contracts";
import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import { parseApiError } from "@/app/_lib/api-error";
import { getUserInitials } from "@/components/user-initials";
import {
  authorLabel,
  formatAbsoluteTime,
  formatRelativeTime,
} from "./comment-presentation";
import {
  QuestionReplyBox,
  QuestionStatusChip,
} from "./work-item-question-parts";

const AGENT_AUTHOR_LABEL = "Scarn";

export function WorkItemCommentItem({
  comment,
  authorHref,
  canManage,
  canPin,
  onChanged,
  onDeleted,
  question,
  onReplied,
  replies,
}: {
  comment: WorkItemCommentContract;
  /** Where the author's name links to: the agent Task that posted it. */
  authorHref?: string;
  canManage: boolean;
  /** Whether the pin/unpin control renders. Any member can pin any comment
   * (feeding the agent isn't author-scoped like edit/delete); a non-member
   * viewer (issue #150) gets neither. */
  canPin: boolean;
  onChanged: (updated: WorkItemCommentContract) => void;
  onDeleted: (id: string) => void;
  /** The question this comment asks, when a run asked it. */
  question?: WorkItemQuestionContract;
  /** Posts a reply under a question comment; omitted when the viewer can't
   * reply. A late reply to a question no longer needed is still allowed. */
  onReplied?: (reply: WorkItemCommentContract) => void;
  /** The comment's replies, rendered under it. */
  replies?: ReactNode;
}) {
  const [error, setError] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editText, setEditText] = useState(comment.body);
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [isPending, startTransition] = useTransition();

  const isAgent = comment.authorKind === "agent";
  const author = isAgent
    ? (comment.authorName ?? AGENT_AUTHOR_LABEL)
    : authorLabel(comment.authorUsername);
  const edited = comment.updatedAt !== comment.createdAt;
  const pinned = comment.isPinned;
  const asking = question?.status === "open";
  const showManage = canManage && !asking;
  const showReplyBox = Boolean(question && isAgent);

  const handleTogglePin = () => {
    setError(null);
    setMenuAnchor(null);
    const nextPinned = !comment.isPinned;
    onChanged({ ...comment, isPinned: nextPinned });
    startTransition(async () => {
      const client = getBrowserScarnApiClient();
      const { data, error: err } = await client.api["work-item-comments"]({
        commentId: parseUuidV7(comment.id),
      }).pin.post({ isPinned: nextPinned });
      if (err) {
        onChanged({ ...comment, isPinned: comment.isPinned });
        setError(parseApiError(err, "Could not update pin. Try again."));
        return;
      }
      onChanged(data);
    });
  };

  const handleEditSave = () => {
    setError(null);
    startTransition(async () => {
      const client = getBrowserScarnApiClient();
      const { data, error: err } = await client.api["work-item-comments"]({
        commentId: parseUuidV7(comment.id),
      }).patch({ body: editText.trim() });
      if (err) {
        setError(parseApiError(err, "Could not save comment. Try again."));
        return;
      }
      onChanged(data);
      setIsEditing(false);
    });
  };

  const handleDelete = () => {
    setError(null);
    setMenuAnchor(null);
    startTransition(async () => {
      const client = getBrowserScarnApiClient();
      const { error: err } = await client.api["work-item-comments"]({
        commentId: parseUuidV7(comment.id),
      }).delete(undefined);
      if (err) {
        setError(parseApiError(err, "Could not delete comment. Try again."));
        return;
      }
      onDeleted(comment.id);
    });
  };

  return (
    <Box
      id={`comment-${comment.id}`}
      data-question-status={question?.status}
      sx={{
        position: "relative",
        minWidth: 0,
        border: 1,
        borderColor: pinned
          ? "primary.main"
          : asking
            ? "warning.main"
            : "divider",
        scrollMarginTop: 16,
        borderRadius: 2,
        overflow: "hidden",
        backgroundColor: "background.paper",
        boxShadow: pinned
          ? "0 0 0 1px color-mix(in srgb, var(--color-accent) 30%, transparent), 0 8px 24px color-mix(in srgb, var(--color-accent) 8%, transparent)"
          : "none",
        transition: "border-color 140ms ease, box-shadow 140ms ease",
        // Cyan spine on the left edge of a pinned comment's own card; a
        // question gets a warning spine while it waits, a muted one after.
        "&::before":
          pinned || question
            ? {
                content: '""',
                position: "absolute",
                top: 0,
                bottom: 0,
                left: 0,
                width: 3,
                backgroundColor: pinned
                  ? "primary.main"
                  : asking
                    ? "warning.main"
                    : "divider",
              }
            : undefined,
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
          backgroundColor: pinned
            ? "color-mix(in srgb, var(--color-accent) 8%, transparent)"
            : "action.hover",
        }}
      >
        <Avatar
          src={comment.authorImage ?? undefined}
          sx={{
            width: 20,
            height: 20,
            fontSize: 10,
            fontWeight: 600,
            bgcolor: pinned
              ? "color-mix(in srgb, var(--color-accent) 22%, transparent)"
              : "action.selected",
            color: pinned ? "primary.main" : "text.secondary",
          }}
        >
          {comment.authorImage
            ? null
            : getUserInitials(isAgent ? author : comment.authorUsername, null)}
        </Avatar>
        {authorHref ? (
          <MuiLink
            component={Link}
            href={authorHref}
            underline="hover"
            color="inherit"
            sx={{ fontWeight: 600, typography: "body2" }}
          >
            {author}
          </MuiLink>
        ) : (
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            {author}
          </Typography>
        )}
        {isAgent ? (
          <Chip
            size="small"
            variant="outlined"
            color="primary"
            label="agent"
            sx={{ height: 20, fontSize: 11, fontWeight: 600 }}
          />
        ) : null}
        <Tooltip title={formatAbsoluteTime(comment.createdAt)}>
          <Typography variant="caption" color="text.secondary">
            {question ? "asked" : "commented"}{" "}
            {formatRelativeTime(comment.createdAt)}
          </Typography>
        </Tooltip>
        {edited ? (
          <Typography variant="caption" color="text.secondary">
            · edited
          </Typography>
        ) : null}

        {question ? <QuestionStatusChip status={question.status} /> : null}

        {pinned ? (
          <Stack
            direction="row"
            spacing={0.5}
            alignItems="center"
            sx={{ color: "primary.main" }}
          >
            <BoltIcon sx={{ fontSize: 14 }} />
            <Typography
              variant="caption"
              sx={{ fontWeight: 700, letterSpacing: "0.01em" }}
            >
              Feeding agent
            </Typography>
          </Stack>
        ) : null}

        <Box sx={{ flexGrow: 1 }} />

        {canPin ? (
          <Tooltip
            title={
              pinned
                ? "Stop feeding this to the agent"
                : "Feed this to the agent"
            }
          >
            <span>
              <IconButton
                size="small"
                onClick={handleTogglePin}
                disabled={isPending}
                aria-label={pinned ? "Unpin comment" : "Pin comment"}
                sx={{ color: pinned ? "primary.main" : "text.secondary" }}
              >
                {pinned ? (
                  <BoltIcon fontSize="small" />
                ) : (
                  <BoltOutlinedIcon fontSize="small" />
                )}
              </IconButton>
            </span>
          </Tooltip>
        ) : null}

        {showManage ? (
          <>
            <Tooltip title="Comment actions">
              <span>
                <IconButton
                  size="small"
                  onClick={(e) => {
                    setMenuAnchor(e.currentTarget);
                  }}
                  disabled={isPending}
                  aria-label="Comment actions"
                >
                  <MoreHorizIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
            <Menu
              anchorEl={menuAnchor}
              open={Boolean(menuAnchor)}
              onClose={() => {
                setMenuAnchor(null);
              }}
            >
              <MenuItem
                onClick={() => {
                  setEditText(comment.body);
                  setError(null);
                  setIsEditing(true);
                  setMenuAnchor(null);
                }}
              >
                <EditOutlinedIcon fontSize="small" sx={{ mr: 1 }} />
                Edit
              </MenuItem>
              <MenuItem onClick={handleDelete} sx={{ color: "error.main" }}>
                <DeleteOutlineIcon fontSize="small" sx={{ mr: 1 }} />
                Delete
              </MenuItem>
            </Menu>
          </>
        ) : null}
      </Stack>

      <Box sx={{ p: 1.5 }}>
        {error ? (
          <Alert severity="error" sx={{ mb: 1 }}>
            {error}
          </Alert>
        ) : null}
        {isEditing ? (
          <Stack spacing={1}>
            <TextField
              multiline
              minRows={3}
              fullWidth
              value={editText}
              onChange={(e) => {
                setEditText(e.target.value);
              }}
              disabled={isPending}
              autoFocus
            />
            <Stack direction="row" spacing={1} justifyContent="flex-end">
              <Button
                size="small"
                onClick={() => {
                  setIsEditing(false);
                  setEditText(comment.body);
                }}
                disabled={isPending}
              >
                Cancel
              </Button>
              <Button
                size="small"
                variant="contained"
                onClick={handleEditSave}
                disabled={isPending || !editText.trim()}
              >
                Save
              </Button>
            </Stack>
          </Stack>
        ) : (
          <Typography
            variant="body2"
            sx={{
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
              lineHeight: 1.6,
            }}
          >
            {comment.body}
          </Typography>
        )}
      </Box>

      {replies ? (
        <Stack
          spacing={1.5}
          sx={{ px: 1.5, pb: 1.5, pl: 3 }}
          data-testid="comment-replies"
        >
          {replies}
        </Stack>
      ) : null}

      {showReplyBox && onReplied ? (
        <QuestionReplyBox comment={comment} onReplied={onReplied} />
      ) : null}
    </Box>
  );
}
