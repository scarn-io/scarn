"use client";

import { Alert, Box, Collapse, Stack, Typography } from "@mui/material";
import { RecordListRow } from "@/components/common/record-list/record-list-row";
import { RespondDialog } from "./respond-dialog";
import { CommentSuppressedNotice } from "./comment-suppressed-notice";
import {
  DeliveriesRow,
  NotificationActions,
  NotificationChips,
  formatTimestamp,
  useNotificationState,
  type NotificationProps,
} from "./notification-internals";

/**
 * Compact, single-row presentation of a notification for use inside a
 * RecordList (e.g. on the work item detail page).
 */
export function NotificationRow({
  notification,
  projectId,
  onDismissed,
  onResponded,
  showWorkItemLink = false,
  isFirst,
}: NotificationProps & { isFirst?: boolean }) {
  const state = useNotificationState({ notification, projectId, onDismissed });
  const {
    expanded,
    respondOpen,
    setRespondOpen,
    error,
    isDismissed,
    hasResponse,
  } = state;

  return (
    <Box sx={{ opacity: isDismissed ? 0.6 : 1 }}>
      <RecordListRow
        isFirst={isFirst}
        primary={
          <Stack spacing={0.5}>
            {error ? <Alert severity="error">{error}</Alert> : null}
            <NotificationChips
              notification={notification}
              hasResponse={hasResponse}
            />
            <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
              {notification.title}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {notification.body}
            </Typography>
            <CommentSuppressedNotice notification={notification} />
          </Stack>
        }
        secondary={
          <Typography variant="caption" color="text.secondary">
            <Box component="span" sx={{ fontFamily: "var(--font-mono)" }}>
              {formatTimestamp(notification.createdAt)}
            </Box>
            {notification.source === "agent" ? " · from agent" : ""}
          </Typography>
        }
        trailing={
          <NotificationActions
            notification={notification}
            state={state}
            showWorkItemLink={showWorkItemLink}
          />
        }
        expanded={
          <Collapse in={expanded}>
            <Box
              sx={{ borderTop: 1, borderColor: "divider", pt: 1.5, mt: 1.5 }}
            >
              <DeliveriesRow
                notificationId={notification.id}
                projectId={projectId}
              />
            </Box>
          </Collapse>
        }
      />
      <RespondDialog
        open={respondOpen}
        notification={notification}
        projectId={projectId}
        onClose={() => {
          setRespondOpen(false);
        }}
        onResponded={onResponded}
      />
    </Box>
  );
}
