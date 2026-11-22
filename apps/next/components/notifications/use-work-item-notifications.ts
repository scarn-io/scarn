"use client";

import { useCallback, useEffect, useState } from "react";
import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import { parseApiError } from "@/app/_lib/api-error";
import { parseUuidV7 } from "@scarn/api/frontend-contracts";
import type {
  UserNotificationContract,
  UserNotificationStatus,
} from "@scarn/api/frontend-contracts";

export type WorkItemNotificationsStatusFilter = "all" | UserNotificationStatus;

export type WorkItemNotificationsData = {
  notifications: UserNotificationContract[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
  setNotifications: React.Dispatch<
    React.SetStateAction<UserNotificationContract[]>
  >;
};

export function useWorkItemNotifications(
  projectId: string,
  workItemId: string,
  statusFilter: WorkItemNotificationsStatusFilter,
  /** Skips fetching entirely when `false` (default `true`). Notifications are
   * per-user and member-only (issue #150); a non-member viewer — anonymous or
   * logged in — has no notifications to show and the endpoint requires a
   * real session, so there's nothing to fetch. */
  enabled = true,
): WorkItemNotificationsData {
  const [notifications, setNotifications] = useState<
    UserNotificationContract[]
  >([]);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    (signal?: { cancelled: boolean }) => {
      if (!enabled) {
        setLoading(false);
        return;
      }
      setLoading(true);
      setError(null);
      const client = getBrowserScarnApiClient();
      const parsedWorkItemId = parseUuidV7(workItemId);
      void client.api
        .projects({ projectId })
        .notifications.get({
          query:
            statusFilter === "all"
              ? { workItemId: parsedWorkItemId }
              : { workItemId: parsedWorkItemId, status: statusFilter },
        })
        .then(({ data, error: err }) => {
          if (signal?.cancelled) return;
          if (err) {
            setError(parseApiError(err, "Could not load notifications."));
            return;
          }
          setNotifications(data);
        })
        .finally(() => {
          if (!signal?.cancelled) setLoading(false);
        });
    },
    [projectId, workItemId, statusFilter, enabled],
  );

  useEffect(() => {
    const signal = { cancelled: false };
    load(signal);
    return () => {
      signal.cancelled = true;
    };
  }, [load]);

  const refresh = useCallback(() => {
    load();
  }, [load]);

  return { notifications, loading, error, refresh, setNotifications };
}
