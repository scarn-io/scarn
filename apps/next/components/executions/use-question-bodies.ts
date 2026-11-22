"use client";

import { useEffect, useState } from "react";
import type { WorkItemCommentContract } from "@scarn/api/frontend-contracts";
import { parseWorkItemId } from "@scarn/api/frontend-contracts";
import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";

/** The question comments' bodies, keyed by comment id. A failed load leaves
 * the map empty; the pane still links to the work item. */
export function useQuestionBodies(
  workItemId: string,
  commentIds: readonly string[],
): ReadonlyMap<string, string> {
  const [bodies, setBodies] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );
  const commentKey = commentIds.join(",");

  useEffect(() => {
    if (commentKey === "") return;
    let cancelled = false;
    const wanted = new Set(commentKey.split(","));
    void getBrowserScarnApiClient()
      .api["work-item-comments"].get({
        query: { workItemId: parseWorkItemId(workItemId) },
      })
      .then(({ data, error }) => {
        if (cancelled || error) return;
        setBodies(
          new Map(
            data
              .filter((comment: WorkItemCommentContract) =>
                wanted.has(comment.id),
              )
              .map((comment) => [comment.id, comment.body]),
          ),
        );
      });
    return () => {
      cancelled = true;
    };
  }, [workItemId, commentKey]);

  return bodies;
}
