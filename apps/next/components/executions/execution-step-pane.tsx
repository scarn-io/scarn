"use client";

/**
 * The step half of the execution page: resolving the `?step=&visit=`
 * selection to a node and visit, loading that visit's thread and latest task,
 * and rendering `StepPage` with its message box (and, for a visit that
 * handed over to a person, its conversation).
 */

import type { ReactNode } from "react";
import type {
  NodeVisitContract,
  PipelineExecutionContract,
} from "@scarn/api/frontend-contracts";
import type {
  StepNavSelection,
  StepPagePatch,
  StepView,
} from "./execution-detail-params";
import {
  resolveSelectedVisit,
  type ExecutionStepItem,
} from "./execution-step-items";
import type { LogStreamFilter } from "./log-viewer";
import { StepMessageBox } from "./step-message-box";
import { StepPage } from "./step-page";
import type { SendStepMessageOutcome } from "./use-execution-detail";
import { useSelectedTaskRun } from "./use-selected-task-run";
import type { WaitControls } from "./use-wait-controls";
import { stepThreadRefreshKey, useStepThread } from "./use-step-thread";
import {
  deriveVisitDisplayStatus,
  latestVisitTask,
  type VisitDisplayStatus,
} from "./visit-status";

export type SelectedStep = {
  step: ExecutionStepItem | null;
  visit: NodeVisitContract | null;
  status: VisitDisplayStatus | null;
};

/** Resolves the URL selection to the node, its selected visit and status. */
export function resolveSelectedStep(
  stepItems: readonly ExecutionStepItem[],
  selection: StepNavSelection,
): SelectedStep {
  if (selection.kind !== "step") {
    return { step: null, visit: null, status: null };
  }
  const step =
    stepItems.find((item) => item.nodeId === selection.nodeId) ?? null;
  const visit = resolveSelectedVisit(step, selection.visitId);
  return {
    step,
    visit,
    status:
      visit === null
        ? (step?.status ?? null)
        : selection.visitId === null
          ? (step?.status ?? deriveVisitDisplayStatus(visit))
          : deriveVisitDisplayStatus(visit),
  };
}

export function ExecutionStepPane({
  execution,
  executionId,
  step,
  visit,
  stepItems,
  banner,
  view,
  logFilter,
  logsRunNumber,
  detailsVisitId,
  onNavigate,
  focusArtifacts,
  fullScreen,
  onFullScreenChange,
  waitControls,
  isMutating,
  pathname,
  searchParams,
  sendVisitMessage,
  onConversationChanged,
  runOverview,
}: {
  execution: PipelineExecutionContract;
  executionId: string;
  step: ExecutionStepItem;
  visit: NodeVisitContract | null;
  stepItems: readonly ExecutionStepItem[];
  banner: ReactNode;
  view: StepView;
  logFilter: LogStreamFilter;
  logsRunNumber: number | null;
  detailsVisitId: string | null;
  onNavigate: (patch: StepPagePatch) => void;
  focusArtifacts: boolean;
  fullScreen: boolean;
  onFullScreenChange: (fullScreen: boolean) => void;
  waitControls: WaitControls;
  isMutating: boolean;
  pathname: string;
  searchParams: URLSearchParams;
  sendVisitMessage: (
    visitId: string,
    body: string,
    quoteText?: string,
  ) => Promise<SendStepMessageOutcome>;
  onConversationChanged: () => void;
  /** The run's overview, for the Details drawer's Run tab. */
  runOverview: ReactNode;
}) {
  const latestTask = visit ? latestVisitTask(visit) : null;
  const { taskRun: selectedTask } = useSelectedTaskRun(
    latestTask?.taskId ?? null,
    latestTask ? `${latestTask.status}:${latestTask.completedAt ?? ""}` : null,
  );
  const thread = useStepThread(
    executionId,
    visit?.nodeKind === "step" ? visit.id : null,
    stepThreadRefreshKey(visit),
  );

  return (
    <StepPage
      key={visit?.id ?? step.nodeId}
      execution={execution}
      step={step}
      visit={visit}
      thread={thread}
      banner={banner}
      view={view}
      logFilter={logFilter}
      logsRunNumber={logsRunNumber}
      detailsVisitId={detailsVisitId}
      onNavigate={onNavigate}
      focusArtifacts={focusArtifacts}
      fullScreen={fullScreen}
      onFullScreenChange={onFullScreenChange}
      waitControls={waitControls}
      onConversationChanged={onConversationChanged}
      runOverview={runOverview}
      renderMessageBox={
        step.kind === "step"
          ? (quote) => (
              <StepMessageBox
                {...quote}
                execution={execution}
                step={step}
                stepItems={stepItems}
                visit={visit}
                selectedTask={selectedTask}
                isMutating={isMutating}
                pathname={pathname}
                searchParams={searchParams}
                sendVisitMessage={sendVisitMessage}
              />
            )
          : null
      }
    />
  );
}
