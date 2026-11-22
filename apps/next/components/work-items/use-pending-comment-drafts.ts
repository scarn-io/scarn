"use client";

import { useCallback, useEffect, useState } from "react";
import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import { parseApiError } from "@/app/_lib/api-error";
import { parseUuidV7 } from "@scarn/api/frontend-contracts";
import type { PendingCommentDraftContract } from "@scarn/api/frontend-contracts";

export type PendingCommentDraftsData = {
  drafts: PendingCommentDraftContract[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
  setDrafts: React.Dispatch<
    React.SetStateAction<PendingCommentDraftContract[]>
  >;
};

export function usePendingCommentDrafts(
  workItemId: string,
  /** Skips fetching entirely when `false`. Only viewers with
   * `work-item-platform-comment:create` can act on drafts, so there's no
   * reason to fetch (or trip a 403) for anyone else. */
  enabled: boolean,
): PendingCommentDraftsData {
  const [drafts, setDrafts] = useState<PendingCommentDraftContract[]>([]);
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
      void client.api["work-item-comment-drafts"]
        .get({ query: { workItemId: parseUuidV7(workItemId) } })
        .then(({ data, error: err }) => {
          if (signal?.cancelled) return;
          if (err) {
            setError(parseApiError(err, "Could not load pending drafts."));
            return;
          }
          setDrafts(data);
        })
        .finally(() => {
          if (!signal?.cancelled) setLoading(false);
        });
    },
    [workItemId, enabled],
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

  return { drafts, loading, error, refresh, setDrafts };
}
