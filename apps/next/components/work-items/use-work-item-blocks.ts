"use client";

import { useCallback, useEffect, useState } from "react";
import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import { parseApiError } from "@/app/_lib/api-error";
import { parseWorkItemId } from "@scarn/api/frontend-contracts";
import type { WorkItemBlockContract } from "@scarn/core/work-items/work-item-block/contracts/work-item-block-contracts";

export type WorkItemBlocksData = {
  blockedBy: WorkItemBlockContract[];
  blocking: WorkItemBlockContract[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
  setBlockedBy: React.Dispatch<React.SetStateAction<WorkItemBlockContract[]>>;
  setBlocking: React.Dispatch<React.SetStateAction<WorkItemBlockContract[]>>;
};

export function useWorkItemBlocks(workItemId: string): WorkItemBlocksData {
  const [blockedBy, setBlockedBy] = useState<WorkItemBlockContract[]>([]);
  const [blocking, setBlocking] = useState<WorkItemBlockContract[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    (signal?: { cancelled: boolean }) => {
      setLoading(true);
      setError(null);
      const client = getBrowserScarnApiClient();
      void client.api["work-item-blocks"]
        .get({ query: { workItemId: parseWorkItemId(workItemId) } })
        .then(({ data, error: err }) => {
          if (signal?.cancelled) return;
          if (err) {
            setError(parseApiError(err, "Could not load work item relationships."));
            return;
          }
          setBlockedBy(data.blockedBy);
          setBlocking(data.blocking);
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

  return { blockedBy, blocking, loading, error, refresh, setBlockedBy, setBlocking };
}
