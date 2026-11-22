"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { z } from "zod";
import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import { unwrapTreatyResponse } from "@/app/_lib/scarn-treaty";
import {
  parseUuidV7,
  workItemConversationSchema,
  type WorkItemConversationContract,
} from "@scarn/api/frontend-contracts";

const workItemConversationsSchema = z.array(workItemConversationSchema);

export type WorkItemConversationsData = {
  conversations: WorkItemConversationContract[];
  refresh: () => void;
};

/**
 * A work item's conversations with their messages, newest first, from
 * `GET /work-items/:workItemId/conversations`. Re-reads when `refreshKey`
 * changes or on `refresh`; a failed read leaves the list as it was, since
 * the list only decorates the page.
 */
export function useWorkItemConversations(
  workItemId: string,
  refreshKey: string,
): WorkItemConversationsData {
  const apiClient = useMemo(() => getBrowserScarnApiClient(), []);
  const [conversations, setConversations] = useState<
    WorkItemConversationContract[]
  >([]);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      try {
        const data = await unwrapTreatyResponse(
          apiClient.api["work-items"]({
            workItemId: parseUuidV7(workItemId),
          }).conversations.get(),
        );
        if (controller.signal.aborted) return;
        const parsed = workItemConversationsSchema.safeParse(data);
        if (parsed.success) setConversations(parsed.data);
      } catch {
        // Keep the last good list; the panel still works from Task statuses.
      }
    };
    void load();
    return () => {
      controller.abort();
    };
  }, [apiClient, workItemId, refreshKey, nonce]);

  const refresh = useCallback(() => {
    setNonce((value) => value + 1);
  }, []);

  return { conversations, refresh };
}
