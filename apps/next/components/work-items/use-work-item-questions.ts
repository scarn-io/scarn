"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import { parseWorkItemId } from "@scarn/api/frontend-contracts";
import type { WorkItemQuestionContract } from "@scarn/api/frontend-contracts";

export type WorkItemQuestionsData = {
  questions: readonly WorkItemQuestionContract[];
  /** Each question comment's question, keyed by the comment's id. */
  byCommentId: ReadonlyMap<string, WorkItemQuestionContract>;
  refresh: () => void;
};

/**
 * The questions runs asked on a work item (`GET /work-items/:id/questions`),
 * so the thread can mark question comments and the agents panel can show
 * the open ones. Re-reads when `refreshKey` changes. A load failure leaves
 * the list empty: the comments still render, just without question states.
 */
export function useWorkItemQuestions(
  workItemId: string,
  refreshKey = "",
): WorkItemQuestionsData {
  const [questions, setQuestions] = useState<WorkItemQuestionContract[]>([]);

  const load = useCallback(
    (signal?: { cancelled: boolean }) => {
      const client = getBrowserScarnApiClient();
      void client.api["work-items"]({ workItemId: parseWorkItemId(workItemId) })
        .questions.get()
        .then(({ data, error }) => {
          if (signal?.cancelled || error) return;
          setQuestions(data);
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
  }, [load, refreshKey]);

  const refresh = useCallback(() => {
    load();
  }, [load]);

  const byCommentId = useMemo(
    () => new Map(questions.map((question) => [question.commentId, question])),
    [questions],
  );

  return { questions, byCommentId, refresh };
}
