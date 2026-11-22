"use client";

import { useEffect, useState } from "react";
import type { WorkItemContract } from "@scarn/api/frontend-contracts";
import { fetchWorkItem } from "@/app/(protected)/projects/_lib/project-work-items";

export type WorkItemParentData = {
  item: WorkItemContract | null;
  loading: boolean;
  error: string | null;
};

/**
 * Fetches the parent work item referenced by `parentWorkItemId`, if any.
 * Used independently by both the header's breadcrumb
 * (`WorkItemDetailHeader`) and the Properties panel's relationships
 * (`WorkItemSidebarRelationships`) — a small duplicated fetch per consumer
 * rather than lifting shared state, consistent with how `useResolvedWorkItems`
 * elsewhere resolves counterpart titles independently per caller.
 */
export function useWorkItemParent(
  parentWorkItemId: string | null,
): WorkItemParentData {
  const [item, setItem] = useState<WorkItemContract | null>(null);
  const [loading, setLoading] = useState(Boolean(parentWorkItemId));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!parentWorkItemId) {
      setItem(null);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchWorkItem(parentWorkItemId)
      .then((result) => {
        if (!cancelled) setItem(result);
      })
      .catch(() => {
        if (!cancelled) setError("Could not load parent work item.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [parentWorkItemId]);

  return { item, loading, error };
}
