"use client";

import { useCallback, useEffect, useState } from "react";
import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import { parseApiError } from "@/app/_lib/api-error";
import { parseWorkItemId } from "@scarn/api/frontend-contracts";
import type { WorkItemCommentContract } from "@scarn/api/frontend-contracts";

export type WorkItemCommentsData = {
  comments: WorkItemCommentContract[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
  setComments: React.Dispatch<React.SetStateAction<WorkItemCommentContract[]>>;
};

export function useWorkItemComments(workItemId: string): WorkItemCommentsData {
  const [comments, setComments] = useState<WorkItemCommentContract[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    (signal?: { cancelled: boolean }) => {
      setLoading(true);
      setError(null);
      const client = getBrowserScarnApiClient();
      void client.api["work-item-comments"]
        .get({ query: { workItemId: parseWorkItemId(workItemId) } })
        .then(({ data, error: err }) => {
          if (signal?.cancelled) return;
          if (err) {
            setError(parseApiError(err, "Could not load comments."));
            return;
          }
          setComments(data);
        })
        .finally(() => {
          if (!signal?.cancelled) setLoading(false);
        });
    },
    [workItemId],
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

  return { comments, loading, error, refresh, setComments };
}
