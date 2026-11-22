"use client";

import { useState, useTransition, useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  Alert,
  Box,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
} from "@mui/material";
import type {
  UserNotificationContract,
  UserNotificationStatus,
} from "@scarn/api/frontend-contracts";
import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import { parseApiError } from "@/app/_lib/api-error";
import { RecordList } from "@/components/common/record-list/record-list";
import { RecordListEmpty } from "@/components/common/record-list/record-list-empty";
import { isPageHidden } from "@/components/use-defer-while-hidden";
import { NotificationRow } from "./notification-row";

type StatusFilter = "all" | UserNotificationStatus;

const STATUS_OPTIONS: Array<{ value: StatusFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "pending", label: "Pending" },
  { value: "delivered", label: "Delivered" },
  { value: "partially_delivered", label: "Partial" },
  { value: "suppressed", label: "Suppressed" },
  { value: "failed", label: "Failed" },
];

type ProjectNotificationsPanelProps = {
  projectId: string;
  initialNotifications: UserNotificationContract[];
  title?: string;
  /** Re-reads the list on this interval while the tab is visible, and when it becomes visible. */
  pollIntervalMs?: number;
};

export function ProjectNotificationsPanel({
  projectId,
  initialNotifications,
  title = "Notifications",
  pollIntervalMs,
}: ProjectNotificationsPanelProps) {
  const router = useRouter();
  const [notifications, setNotifications] = useState(initialNotifications);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // useTransition keeps the filter Select responsive while refetching.
  const [, startTransition] = useTransition();

  const refetch = useCallback(
    (status: StatusFilter, { quiet = false }: { quiet?: boolean } = {}) => {
      if (!quiet) {
        setLoading(true);
        setError(null);
      }
      const client = getBrowserScarnApiClient();
      void client.api
        .projects({ projectId })
        .notifications.get({
          query: status === "all" ? {} : { status },
        })
        .then(({ data, error: err }) => {
          if (err) {
            if (!quiet) {
              setError(parseApiError(err, "Could not load notifications."));
            }
            return;
          }
          setError(null);
          setNotifications(data);
        })
        .finally(() => {
          setLoading(false);
        });
    },
    [projectId],
  );

  useEffect(() => {
    if (pollIntervalMs === undefined) return;
    const poll = () => {
      if (!isPageHidden()) refetch(statusFilter, { quiet: true });
    };
    const intervalId = setInterval(poll, pollIntervalMs);
    document.addEventListener("visibilitychange", poll);
    return () => {
      clearInterval(intervalId);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [pollIntervalMs, refetch, statusFilter]);

  const handleStatusFilterChange = (next: StatusFilter) => {
    startTransition(() => {
      setStatusFilter(next);
    });
    refetch(next);
  };

  const handleDismissed = (id: string) => {
    if (statusFilter === "all") {
      setNotifications((prev) =>
        prev.map((n) =>
          n.id === id ? { ...n, status: "suppressed" as const } : n,
        ),
      );
    } else {
      setNotifications((prev) => prev.filter((n) => n.id !== id));
    }
  };

  const handleResponded = (updated: UserNotificationContract) => {
    setNotifications((prev) =>
      prev.map((n) => (n.id === updated.id ? updated : n)),
    );
    // Answering a feedback request may promote the answer into a project
    // context entry. Refresh server components so the Context panel reflects
    // the new entry on next render/navigation.
    router.refresh();
  };

  const headerAction = (
    <FormControl size="small" sx={{ minWidth: 160 }}>
      <InputLabel id="status-filter-label">Status</InputLabel>
      <Select
        labelId="status-filter-label"
        value={statusFilter}
        label="Status"
        onChange={(e) => {
          handleStatusFilterChange(e.target.value);
        }}
      >
        {STATUS_OPTIONS.map((opt) => (
          <MenuItem key={opt.value} value={opt.value}>
            {opt.label}
          </MenuItem>
        ))}
      </Select>
    </FormControl>
  );

  return (
    <RecordList
      title={title}
      count={loading ? undefined : notifications.length}
      headerAction={headerAction}
    >
      {error ? (
        <Box sx={{ p: 2 }}>
          <Alert severity="error">{error}</Alert>
        </Box>
      ) : notifications.length === 0 ? (
        <RecordListEmpty
          title="No notifications"
          description={
            statusFilter === "all"
              ? "No notifications have been recorded for this project yet. They appear here when the agent needs your attention."
              : "No notifications match the selected filter."
          }
        />
      ) : (
        notifications.map((notification, index) => (
          <NotificationRow
            key={notification.id}
            notification={notification}
            projectId={projectId}
            onDismissed={handleDismissed}
            onResponded={handleResponded}
            showWorkItemLink
            isFirst={index === 0}
          />
        ))
      )}
    </RecordList>
  );
}
