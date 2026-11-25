"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type ReactNode,
} from "react";
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import type {
  WorkItemCommentContract,
  WorkItemContract,
  WorkItemQuestionContract,
} from "@scarn/api/frontend-contracts";
import { parseWorkItemId } from "@scarn/api/frontend-contracts";
import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import { parseApiError } from "@/app/_lib/api-error";
import { authClient } from "@/app/_lib/auth-client";
import {
  useHasProjectPermission,
  useIsProjectMember,
  useProjectPath,
} from "@/components/project-route-context";
import { useWorkItemComments } from "./use-work-item-comments";
import { usePendingCommentDrafts } from "./use-pending-comment-drafts";
import { WorkItemCommentItem } from "./work-item-comment-item";
import { WorkItemCommentDraftItem } from "./work-item-comment-draft-item";

/**
 * The Comments tab: people's comments, agent summary comments, pending
 * drafts and question comments as a record. Replies here are plain
 * comments; agents and questions are answered in the agents panel.
 */
export function WorkItemCommentsSection({
  workItem,
  questionsByCommentId,
  commentsVersion = 0,
  onPinnedCountChange,
}: {
  workItem: WorkItemContract;
  /** The run questions on this item, keyed by their question comment. */
  questionsByCommentId: ReadonlyMap<string, WorkItemQuestionContract>;
  /** Bump to reload the thread after the server posts to it (e.g. a close's
   * resolution or an agent's summary). */
  commentsVersion?: number;
  /** Reports how many comments are pinned (feeding the agent). */
  onPinnedCountChange?: (count: number) => void;
}) {
  const workItemId = workItem.id;
  const { data: session } = authClient.useSession();
  const currentUserId = session?.user.id;
  const isMember = useIsProjectMember();
  const projectPath = useProjectPath();
  const {
    comments,
    loading,
    error,
    setComments,
    refresh: refreshComments,
  } = useWorkItemComments(workItemId);
  const loadedCommentsVersion = useRef(commentsVersion);
  useEffect(() => {
    if (loadedCommentsVersion.current === commentsVersion) return;
    loadedCommentsVersion.current = commentsVersion;
    refreshComments();
  }, [commentsVersion, refreshComments]);
  const canApproveCommentDrafts = useHasProjectPermission(
    "work-item-platform-comment:write",
  );
  const { drafts, setDrafts } = usePendingCommentDrafts(
    workItemId,
    canApproveCommentDrafts,
  );
  const [draft, setDraft] = useState("");

  const { topLevel, repliesByParent } = useMemo(
    () => threadComments(comments),
    [comments],
  );

  const pinnedCount = useMemo(
    () => comments.filter((c) => c.isPinned).length,
    [comments],
  );

  useEffect(() => {
    if (!loading) onPinnedCountChange?.(pinnedCount);
  }, [loading, pinnedCount, onPinnedCountChange]);

  const [composerError, setComposerError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const handleSubmit = () => {
    const text = draft.trim();
    if (!text) return;
    setComposerError(null);
    startTransition(async () => {
      const client = getBrowserScarnApiClient();
      const { data, error: err } = await client.api["work-item-comments"].post({
        workItemId: parseWorkItemId(workItemId),
        body: text,
      });
      if (err) {
        setComposerError(
          parseApiError(err, "Could not add comment. Try again."),
        );
        return;
      }
      setComments((prev) => [...prev, data]);
      setDraft("");
    });
  };

  const handleChanged = (updated: WorkItemCommentContract) => {
    setComments((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
  };

  const handleDeleted = (id: string) => {
    setComments((prev) =>
      prev.filter((c) => c.id !== id && c.parentCommentId !== id),
    );
  };

  const handleReplied = (reply: WorkItemCommentContract) => {
    setComments((prev) => [...prev, reply]);
  };

  const renderComment = (
    comment: WorkItemCommentContract,
    replies?: ReactNode,
  ) => {
    const question = questionsByCommentId.get(comment.id);
    return (
      <WorkItemCommentItem
        key={comment.id}
        comment={comment}
        authorHref={
          comment.authoredByTaskId
            ? projectPath("runs", "tasks", comment.authoredByTaskId)
            : undefined
        }
        canManage={isMember && currentUserId === comment.authorUserId}
        canPin={isMember}
        onChanged={handleChanged}
        onDeleted={handleDeleted}
        question={question}
        onReplied={question && isMember ? handleReplied : undefined}
        replies={replies}
      />
    );
  };

  const handleDraftRejected = (notificationId: string) => {
    setDrafts((prev) =>
      prev.filter((d) => d.notification.id !== notificationId),
    );
  };

  return (
    <Stack spacing={2.5}>
      {canApproveCommentDrafts && drafts.length > 0 ? (
        <Stack spacing={1.5}>
          {drafts.map((pendingDraft) => (
            <WorkItemCommentDraftItem
              key={pendingDraft.notification.id}
              draft={pendingDraft}
              workItemPlatform={workItem.platform}
              onApproved={(comment) => {
                setComments((prev) => [...prev, comment]);
                setDrafts((prev) =>
                  prev.filter(
                    (d) => d.notification.id !== pendingDraft.notification.id,
                  ),
                );
              }}
              onRejected={handleDraftRejected}
            />
          ))}
        </Stack>
      ) : null}
      {error ? (
        // A comments-only failure (e.g. missing comments:read) must not hide
        // the rest of the page; surface it inline where the thread goes.
        <Alert severity="error">{error}</Alert>
      ) : loading ? (
        <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
          <CircularProgress />
        </Box>
      ) : comments.length === 0 ? (
        <EmptyThread />
      ) : (
        topLevel.map((comment) => {
          const replies = repliesByParent.get(comment.id);
          return renderComment(
            comment,
            replies && replies.length > 0
              ? replies.map((reply) => renderComment(reply))
              : undefined,
          );
        })
      )}

      {/* Composer, styled as a new comment card. Hidden for a non-member
            (issue #150) and when comments failed to load: if the thread can't
            be read, offering a reply box that will only fail on submit is
            misleading. */}
      {error || !isMember ? null : (
        <Box
          sx={{
            border: 1,
            borderColor: "divider",
            borderRadius: 2,
            backgroundColor: "background.paper",
            p: 1.5,
            transition: "border-color 120ms ease",
            "&:focus-within": { borderColor: "var(--color-border-strong)" },
          }}
        >
          <Stack spacing={1.25}>
            {composerError ? (
              <Alert severity="error">{composerError}</Alert>
            ) : null}
            <TextField
              placeholder="Add a reply…"
              multiline
              minRows={3}
              fullWidth
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
              }}
              disabled={isPending}
            />
            <Stack
              direction="row"
              justifyContent="space-between"
              alignItems="center"
              spacing={1}
            >
              <Typography variant="caption" color="text.secondary">
                Reply, then pin it to send it to the agent.
              </Typography>
              <Button
                variant="contained"
                onClick={handleSubmit}
                disabled={isPending || !draft.trim()}
              >
                Reply
              </Button>
            </Stack>
          </Stack>
          <Typography
            variant="caption"
            color="text.secondary"
            component="p"
            sx={{ mt: 1 }}
          >
            Comments don&apos;t answer agents or questions — reply in the panel
            above.
          </Typography>
        </Box>
      )}
    </Stack>
  );
}

/**
 * Splits the flat comment list into top-level comments and each one's
 * replies (one level deep). A reply whose parent isn't loaded shows as
 * top-level rather than disappearing.
 */
function threadComments(comments: readonly WorkItemCommentContract[]): {
  topLevel: WorkItemCommentContract[];
  repliesByParent: Map<string, WorkItemCommentContract[]>;
} {
  const ids = new Set(comments.map((comment) => comment.id));
  const topLevel: WorkItemCommentContract[] = [];
  const repliesByParent = new Map<string, WorkItemCommentContract[]>();
  for (const comment of comments) {
    const parentId = comment.parentCommentId;
    if (parentId && ids.has(parentId)) {
      const siblings = repliesByParent.get(parentId) ?? [];
      siblings.push(comment);
      repliesByParent.set(parentId, siblings);
    } else {
      topLevel.push(comment);
    }
  }
  return { topLevel, repliesByParent };
}

/** Direction, not decoration: an empty thread invites the first reply. */
function EmptyThread() {
  return (
    <Box
      sx={{
        border: 1,
        borderColor: "divider",
        borderStyle: "dashed",
        borderRadius: 2,
        p: 2,
        backgroundColor: "background.paper",
      }}
    >
      <Typography variant="body2" color="text.secondary">
        No replies yet. Add one below to start building context for the agent.
      </Typography>
    </Box>
  );
}
