"use client";

import {
  Alert,
  Box,
  CircularProgress,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
} from "@mui/material";
import type { UserNotificationContract } from "@scarn/api/frontend-contracts";
import { RecordListEmpty } from "@/components/common/record-list/record-list-empty";
import { NotificationRow } from "./notification-row";
import type {
  WorkItemNotificationsData,
  WorkItemNotificationsStatusFilter,
} from "./use-work-item-notifications";

const STATUS_OPTIONS: Array<{
  value: WorkItemNotificationsStatusFilter;
  label: string;
}> = [
  { value: "all", label: "All" },
  { value: "pending", label: "Pending" },
  { value: "delivered", label: "Delivered" },
  { value: "partially_delivered", label: "Partial" },
  { value: "suppressed", label: "Suppressed" },
  { value: "failed", label: "Failed" },
];

/** Status filter control rendered in the drawer header. */
export function NotificationsStatusFilter({
  statusFilter,
  onChange,
}: {
  statusFilter: WorkItemNotificationsStatusFilter;
  onChange: (value: WorkItemNotificationsStatusFilter) => void;
}) {
  return (
    <FormControl size="small" sx={{ minWidth: 140 }}>
      <InputLabel id="wi-notif-status-filter-label">Status</InputLabel>
      <Select
        labelId="wi-notif-status-filter-label"
        value={statusFilter}
        label="Status"
        onChange={(e) => {
          onChange(e.target.value);
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
}

/** The scrollable notifications list rendered inside the drawer. */
export function WorkItemNotificationsDrawerBody({
  projectId,
  statusFilter,
  data,
  onDismissed,
  onResponded,
}: {
  projectId: string;
  statusFilter: WorkItemNotificationsStatusFilter;
  data: WorkItemNotificationsData;
  onDismissed: (id: string) => void;
  onResponded: (updated: UserNotificationContract) => void;
}) {
  const { notifications, loading, error } = data;

  if (error) {
    return (
      <Box sx={{ p: 1 }}>
        <Alert severity="error">{error}</Alert>
      </Box>
    );
  }

  if (loading) {
    return (
      <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (notifications.length === 0) {
    return (
      <RecordListEmpty
        title="No notifications"
        description={
          statusFilter === "all"
            ? "No notifications have been recorded for this work item yet."
            : "No notifications match the selected filter."
        }
      />
    );
  }

  return (
    <Box
      sx={{
        border: 1,
        borderColor: "divider",
        borderRadius: 2,
        overflow: "hidden",
      }}
    >
      {notifications.map((notification, index) => (
        <NotificationRow
          key={notification.id}
          notification={notification}
          projectId={projectId}
          onDismissed={onDismissed}
          onResponded={onResponded}
          showWorkItemLink={false}
          isFirst={index === 0}
        />
      ))}
    </Box>
  );
}
