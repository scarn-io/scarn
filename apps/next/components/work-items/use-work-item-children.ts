"use client";

import { useCallback, useEffect, useState } from "react";
import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import { parseApiError } from "@/app/_lib/api-error";
import { parseWorkItemId } from "@scarn/api/frontend-contracts";
import type { ChildWorkItemContract } from "@scarn/api/frontend-contracts";

export type WorkItemChildrenData = {
  children: ChildWorkItemContract[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
  setChildren: React.Dispatch<React.SetStateAction<ChildWorkItemContract[]>>;
};

export function useWorkItemChildren(workItemId: string): WorkItemChildrenData {
  const [children, setChildren] = useState<ChildWorkItemContract[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    (signal?: { cancelled: boolean }) => {
      setLoading(true);
      setError(null);
      const client = getBrowserScarnApiClient();
      void client.api["work-items"]({ workItemId: parseWorkItemId(workItemId) })
        .children.get()
        .then(({ data, error: err }) => {
          if (signal?.cancelled) return;
          if (err) {
            setError(parseApiError(err, "Could not load child work items."));
            return;
          }
          setChildren(data);
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

  return { children, loading, error, refresh, setChildren };
}
