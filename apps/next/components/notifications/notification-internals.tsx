"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import {
  Box,
  Button,
  Chip,
  CircularProgress,
  Stack,
  Typography,
} from "@mui/material";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import ExpandLessIcon from "@mui/icons-material/ExpandLess";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import type {
  UserNotificationContract,
  UserNotificationWithDeliveriesContract,
} from "@scarn/api/frontend-contracts";
import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import { parseApiError } from "@/app/_lib/api-error";
import { StatusChip } from "@/components/common/status-chip";
import { useProjectPath } from "@/components/project-route-context";

export const formatTimestamp = (value: string | null | undefined) =>
  value ? new Date(value).toLocaleString() : "—";

export const NOTIFICATION_KIND_LABELS: Record<string, string> = {
  feedback_request: "Feedback Request",
  status_update: "Status Update",
  blocked: "Blocked",
  result_ready: "Result Ready",
  warning: "Warning",
};

export const PRIORITY_LABELS: Record<string, string> = {
  low: "Low",
  normal: "Normal",
  high: "High",
  urgent: "Urgent",
};

export type NotificationProps = {
  notification: UserNotificationContract;
  projectId: string;
  onDismissed: (id: string) => void;
  onResponded: (updated: UserNotificationContract) => void;
  /** Whether to render the "Work item" link. Defaults to false. */
  showWorkItemLink?: boolean;
};

export function DeliveriesRow({
  notificationId,
  projectId,
}: {
  notificationId: string;
  projectId: string;
}) {
  const [detail, setDetail] =
    useState<UserNotificationWithDeliveriesContract | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const client = getBrowserScarnApiClient();
    let cancelled = false;
    setLoading(true);
    void client.api
      .projects({ projectId })
      .notifications({ notificationId })
      .get()
      .then(({ data, error: err }) => {
        if (cancelled) return;
        if (err) {
          setError("Could not load delivery details.");
          return;
        }
        setDetail(data);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [notificationId, projectId]);

  if (loading) {
    return (
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, pt: 1 }}>
        <CircularProgress size={14} />
        <Typography variant="caption" color="text.secondary">
          Loading deliveries…
        </Typography>
      </Box>
    );
  }

  if (error) {
    return (
      <Typography variant="caption" color="error">
        {error}
      </Typography>
    );
  }

  const deliveries = detail?.deliveries ?? [];

  if (deliveries.length === 0) {
    return (
      <Typography variant="caption" color="text.secondary">
        No deliveries recorded.
      </Typography>
    );
  }

  return (
    <Stack spacing={0.5} sx={{ pt: 1 }}>
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ fontWeight: 600 }}
      >
        Delivery channels
      </Typography>
      <Stack spacing={0.5}>
        {deliveries.map((d) => (
          <Stack key={d.id} direction="row" spacing={1} alignItems="center">
            <Chip
              label={d.channel.replace("_", " ")}
              size="small"
              variant="outlined"
              sx={{ textTransform: "capitalize" }}
            />
            <StatusChip value={d.status} />
            {d.suppressionReason ? (
              <Typography variant="caption" color="text.secondary">
                {d.suppressionReason.replace(/_/g, " ")}
              </Typography>
            ) : null}
            {d.sentAt ? (
              <Typography variant="caption" color="text.secondary">
                {formatTimestamp(d.sentAt)}
              </Typography>
            ) : null}
          </Stack>
        ))}
      </Stack>
    </Stack>
  );
}

/**
 * Shared interaction state + handlers for a single notification, used by both
 * the card and the compact row presentations.
 */
export function useNotificationState({
  notification,
  projectId,
  onDismissed,
}: {
  notification: UserNotificationContract;
  projectId: string;
  onDismissed: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [respondOpen, setRespondOpen] = useState(false);
  const [confirmDismiss, setConfirmDismiss] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const isDismissed = notification.status === "suppressed";

  const handleDismiss = () => {
    setError(null);
    startTransition(async () => {
      const client = getBrowserScarnApiClient();
      const { error: err } = await client.api
        .projects({ projectId })
        .notifications({ notificationId: notification.id })
        .dismiss.post();
      if (err) {
        setError(parseApiError(err, "Could not dismiss. Try again."));
        setConfirmDismiss(false);
        return;
      }
      onDismissed(notification.id);
    });
  };

  const payload = notification.payloadJson as Record<string, unknown> | null;
  const hasResponse =
    payload !== null && typeof payload === "object" && "response" in payload;

  return {
    expanded,
    setExpanded,
    respondOpen,
    setRespondOpen,
    confirmDismiss,
    setConfirmDismiss,
    error,
    isPending,
    isDismissed,
    handleDismiss,
    hasResponse,
  };
}

/**
 * The repo conversation (chat) a notification is about: a notification with
 * no work item whose payload names a `conversationId`. Work-item hand-overs
 * also carry one, but they're answered in place with Respond. The payload has
 * no Task id, so the link goes through `conversations/[id]`, which redirects
 * to the chat's Task page.
 */
export const readRepoConversationId = (
  notification: Pick<UserNotificationContract, "workItemId" | "payloadJson">,
): string | null => {
  if (notification.workItemId !== null) {
    return null;
  }
  const conversationId = notification.payloadJson?.["conversationId"];
  return typeof conversationId === "string" ? conversationId : null;
};

/**
 * The grant request a waiting-for-person notification is about: its agent
 * asks for more access. Null for any other notification.
 */
export const readGrantRequestId = (
  notification: Pick<UserNotificationContract, "payloadJson">,
): string | null => {
  const grantRequestId = notification.payloadJson?.["grantRequestId"];
  return typeof grantRequestId === "string" ? grantRequestId : null;
};

/** Action buttons shared by both card and row presentations. */
export function NotificationActions({
  notification,
  state,
  showWorkItemLink,
}: {
  notification: UserNotificationContract;
  state: ReturnType<typeof useNotificationState>;
  showWorkItemLink: boolean;
}) {
  const projectPath = useProjectPath();
  const {
    isDismissed,
    isPending,
    hasResponse,
    confirmDismiss,
    setConfirmDismiss,
    setRespondOpen,
    handleDismiss,
    expanded,
    setExpanded,
  } = state;
  const conversationId = readRepoConversationId(notification);

  return (
    <>
      {notification.kind === "feedback_request" &&
      !hasResponse &&
      !isDismissed ? (
        <Button
          size="small"
          variant="contained"
          onClick={() => {
            setRespondOpen(true);
          }}
          disabled={isPending}
        >
          Respond
        </Button>
      ) : null}

      {!isDismissed ? (
        confirmDismiss ? (
          <>
            <Typography variant="body2" color="text.secondary">
              Dismiss?
            </Typography>
            <Button
              size="small"
              color="error"
              variant="contained"
              onClick={handleDismiss}
              disabled={isPending}
            >
              Yes
            </Button>
            <Button
              size="small"
              variant="text"
              onClick={() => {
                setConfirmDismiss(false);
              }}
              disabled={isPending}
            >
              Cancel
            </Button>
          </>
        ) : (
          <Button
            size="small"
            variant="text"
            onClick={() => {
              setConfirmDismiss(true);
            }}
            disabled={isPending}
          >
            Dismiss
          </Button>
        )
      ) : null}

      {conversationId ? (
        <Button
          size="small"
          variant="text"
          component={Link}
          href={projectPath("conversations", conversationId)}
          endIcon={<OpenInNewIcon fontSize="inherit" />}
        >
          Task
        </Button>
      ) : null}

      {showWorkItemLink && notification.workItemId ? (
        <Button
          size="small"
          variant="text"
          component={Link}
          href={projectPath("work-items", notification.workItemId)}
          endIcon={<OpenInNewIcon fontSize="inherit" />}
        >
          Work item
        </Button>
      ) : null}

      <Button
        size="small"
        variant="text"
        endIcon={expanded ? <ExpandLessIcon /> : <ExpandMoreIcon />}
        onClick={() => {
          setExpanded((v) => !v);
        }}
      >
        {expanded ? "Less" : "Details"}
      </Button>
    </>
  );
}

/** Status / kind / priority chip row shared by both presentations. */
export function NotificationChips({
  notification,
  hasResponse,
}: {
  notification: UserNotificationContract;
  hasResponse: boolean;
}) {
  return (
    <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
      <StatusChip
        value={notification.kind}
        label={NOTIFICATION_KIND_LABELS[notification.kind] ?? notification.kind}
      />
      <StatusChip
        value={notification.priority}
        label={PRIORITY_LABELS[notification.priority]}
      />
      <StatusChip value={notification.status} />
      {hasResponse ? <StatusChip value="done" label="Answered" /> : null}
    </Stack>
  );
}
