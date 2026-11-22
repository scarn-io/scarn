"use client";

import { useMemo, useState } from "react";
import type {
  NodeVisitContract,
  PipelineExecutionContract,
  TaskRunContract,
} from "@scarn/api/frontend-contracts";
import { useHasProjectPermission } from "@/components/project-route-context";
import { buildSelectionHref } from "./execution-detail-params";
import { resolveStepMessageGate } from "./execution-step-action-guards";
import type { ExecutionStepItem } from "./execution-step-items";
import { StepMessageComposer } from "./step-message-composer";
import type { SendStepMessageOutcome } from "./use-execution-detail";
import { latestVisitTask } from "./visit-status";

/**
 * The display names of the steps a message to `step` re-runs: the step
 * itself, then every step after it in position order.
 */
export function rerunStepNames(
  step: ExecutionStepItem,
  stepItems: readonly ExecutionStepItem[],
): string[] {
  const after = stepItems
    .filter((item) => item.position > step.position && item.kind === "step")
    .sort((left, right) => left.position - right.position);
  return [step, ...after].map((item) => item.title);
}

/**
 * Connects `StepMessageComposer` to the execution detail page: resolves the
 * gate from the viewer's permission and the selected visit, names the steps a
 * send re-runs, and owns the in-flight and error state of a send. Replies to
 * a waiting agent go through the conversation panel, not here. The quote is
 * owned by the page (the thread's Quote button sets it) and is cleared once a
 * send succeeds.
 */
export function StepMessageBox({
  execution,
  step,
  stepItems,
  visit,
  selectedTask,
  isMutating,
  pathname,
  searchParams,
  quote,
  onClearQuote,
  sendVisitMessage,
}: {
  execution: PipelineExecutionContract;
  step: ExecutionStepItem;
  /** Every node of the run, for the re-run consequence line. */
  stepItems: readonly ExecutionStepItem[];
  visit: NodeVisitContract | null;
  selectedTask: TaskRunContract | null;
  isMutating: boolean;
  pathname: string;
  searchParams: URLSearchParams;
  quote: string | null;
  onClearQuote: () => void;
  sendVisitMessage: (
    visitId: string,
    body: string,
    quoteText?: string,
  ) => Promise<SendStepMessageOutcome>;
}) {
  const canWriteExecutions = useHasProjectPermission("executions:write");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const rerunSteps = useMemo(
    () => rerunStepNames(step, stepItems),
    [step, stepItems],
  );

  const latestTaskId = visit ? latestVisitTask(visit)?.taskId : undefined;
  const rerunGate = resolveStepMessageGate({
    canWriteExecutions,
    execution,
    visit,
    nodeKind: step.kind,
    taskKind:
      latestTaskId !== undefined && selectedTask?.id === latestTaskId
        ? selectedTask.kind
        : null,
    currentVisitHref: buildSelectionHref(pathname, searchParams, {
      kind: "step",
      nodeId: step.nodeId,
      visitId: null,
    }),
    isMutating: isMutating && !sending,
  });
  const handleSend = async (body: string, quoteText: string | null) => {
    if (!visit) return false;
    setSending(true);
    setError("");
    const outcome = await sendVisitMessage(
      visit.id,
      body,
      quoteText ?? undefined,
    );
    setSending(false);
    if (outcome.ok) onClearQuote();
    else setError(outcome.error);
    return outcome.ok;
  };

  return (
    <StepMessageComposer
      gate={rerunGate}
      rerunSteps={rerunSteps}
      quote={quote}
      onClearQuote={onClearQuote}
      pending={sending}
      error={error}
      onSend={handleSend}
    />
  );
}
