"use client";

import { useEffect, useMemo, useState } from "react";
import {
  MAX_WORK_ITEM_STATUS_IDS,
  type WorkItemStatusSummaryContract,
} from "@scarn/api/frontend-contracts";
import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import { workItemIdsInText } from "./work-item-links";

export type WorkItemLinkStatuses = ReadonlyMap<
  string,
  WorkItemStatusSummaryContract
>;

/**
 * The live title and status of every work item `text` links to, keyed by id.
 * Ids already in `known` (such as the loaded children) are taken from it;
 * the rest are fetched in one project-scoped request whenever that set of
 * ids changes. Ids the project doesn't have stay absent, so their links stay
 * plain. A failed lookup is treated the same way.
 */
export function useWorkItemLinkStatuses(
  projectId: string,
  text: string,
  known: readonly WorkItemStatusSummaryContract[],
): WorkItemLinkStatuses {
  const knownById = useMemo(
    () => new Map(known.map((item) => [item.id as string, item])),
    [known],
  );
  const ids = useMemo(() => workItemIdsInText(text), [text]);
  const missingKey = useMemo(
    () =>
      ids
        .filter((id) => !knownById.has(id))
        .slice(0, MAX_WORK_ITEM_STATUS_IDS)
        .join(","),
    [ids, knownById],
  );
  const [fetched, setFetched] = useState<{
    key: string;
    items: WorkItemStatusSummaryContract[];
  }>({ key: "", items: [] });

  useEffect(() => {
    if (!missingKey) return;
    let cancelled = false;
    void getBrowserScarnApiClient()
      .api.projects({ projectId })
      ["work-item-statuses"].get({ query: { ids: missingKey } })
      .then(({ data, error }) => {
        if (cancelled) return;
        setFetched({ key: missingKey, items: error ? [] : data });
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, missingKey]);

  return useMemo(() => {
    const statuses = new Map<string, WorkItemStatusSummaryContract>();
    if (fetched.key === missingKey) {
      for (const item of fetched.items) statuses.set(item.id, item);
    }
    for (const id of ids) {
      const item = knownById.get(id);
      if (item) statuses.set(id, item);
    }
    return statuses;
  }, [ids, knownById, fetched, missingKey]);
}
