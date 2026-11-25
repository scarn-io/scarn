"use client";

/**
 * The selected node's page body. Its title, `Conversation | Logs` toggle
 * (`?view=`) and Details button live in the execution header bar
 * (`ExecutionHeaderStep`). For a step node the body is the selected visit's
 * conversation in its own scroll container with the message box pinned under
 * it, or `StepLogsView` for one run (`?run=`). Wait nodes show their decision
 * or the questions they wait on, and end nodes their outcome. A run's Output opens the Details drawer
 * (`?details=`); a run's Logs link and the drawer's Open logs switch to Logs
 * on that run. Selecting agent text in the thread quotes it into the message
 * box; the page is keyed by visit, so a quote never outlives its visit.
 * A step visit that handed over to a person shows its `ConversationPanel`
 * first, with its attempts collapsed under it; while the conversation takes
 * replies, its reply box replaces the Rerun with message box.
 */

import { Alert, Box, CircularProgress, Stack, Typography } from "@mui/material";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  NodeVisitContract,
  PipelineExecutionContract,
} from "@scarn/api/frontend-contracts";
import {
  ConversationMessageBox,
  ConversationPanel,
  acceptsReplies,
} from "@/components/conversations/conversation-panel";
import { ConversationScroller } from "@/components/conversations/conversation-scroller";
import { useConversation } from "@/components/conversations/use-conversation";
import { useHasProjectPermission } from "@/components/project-route-context";
import type { StepPagePatch, StepView } from "./execution-detail-params";
import type { ExecutionStepItem } from "./execution-step-items";
import type { LogStreamFilter } from "./log-viewer";
import { StepDetailsDrawer } from "./step-details-drawer";
import { StepLogsView } from "./step-logs-view";
import { StepThread, isRunOpen } from "./step-thread";
import {
  buildThreadRuns,
  visitThreadRuns,
  type StepThreadRun,
} from "./step-thread-model";
import { TextLink } from "./thread-parts";
import type { StepThreadData } from "./use-step-thread";
import { latestVisitTask } from "./visit-status";
import { EndNodePanel } from "./visit-node-panels";
import type { WaitControls } from "./use-wait-controls";
import { WaitVisitPanel } from "./wait-visit-panel";

/** The quote attached to the message box, and how to drop it. */
export type MessageBoxQuote = {
  quote: string | null;
  onClearQuote: () => void;
};

/** The thread column's max width. */
const THREAD_COLUMN_WIDTH = 760;

export function StepPage({
  execution,
  step,
  visit,
  thread,
  banner,
  renderMessageBox,
  view,
  logFilter,
  logsRunNumber,
  detailsVisitId,
  onNavigate,
  focusArtifacts,
  fullScreen,
  onFullScreenChange,
  waitControls,
  onConversationChanged,
  runOverview,
}: {
  execution: PipelineExecutionContract;
  step: ExecutionStepItem;
  /** The selected visit of the node; `null` when it hasn't been visited. */
  visit: NodeVisitContract | null;
  thread: StepThreadData;
  /** Shown above the body (the mobile steps panel and page alerts). */
  banner?: ReactNode;
  /** `null` when the node takes no messages (wait/succeed/fail). */
  renderMessageBox: ((quote: MessageBoxQuote) => ReactNode) | null;
  view: StepView;
  /** The Logs view's stream filter (`?filter=`). */
  logFilter: LogStreamFilter;
  /** The run the Logs view shows (`?run=`); `null` is the latest. */
  logsRunNumber: number | null;
  /** The visit the Details drawer is open on; `null` when it's closed. */
  detailsVisitId: string | null;
  /** Writes the step page's URL params. */
  onNavigate: (patch: StepPagePatch) => void;
  focusArtifacts: boolean;
  /** The Logs view fills the window (the header and rail are hidden). */
  fullScreen: boolean;
  onFullScreenChange: (fullScreen: boolean) => void;
  /** What a wait node's pane can do. */
  waitControls: WaitControls;
  /** Runs after a conversation action, so the run catches up with it. */
  onConversationChanged?: () => void;
  /** The run's overview, for the Details drawer's Run tab. */
  runOverview: ReactNode;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [quote, setQuote] = useState<string | null>(null);
  const canWriteExecutions = useHasProjectPermission("executions:write");
  const canCreateComments = useHasProjectPermission("comments:write");
  const conversationId =
    visit?.nodeKind === "step" ? visit.conversationId : null;
  const conversation = useConversation(conversationId, {
    refreshKey: conversationRefreshKey(visit),
    onChanged: onConversationChanged,
  });
  const replying =
    conversationId !== null &&
    canCreateComments &&
    acceptsReplies(conversation.conversation);
  const canQuote = renderMessageBox !== null && canWriteExecutions && !replying;
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [workTaskId, setWorkTaskId] = useState<string | null>(null);
  const detailsOpen = detailsVisitId !== null;
  const inLogs = view === "logs";

  const runs = useMemo((): StepThreadRun[] => {
    if (!visit) return [];
    if (thread.thread && thread.thread.runs.length > 0) {
      return buildThreadRuns(thread.thread.runs, execution.visits);
    }
    if (thread.loading) return [];
    return visitThreadRuns(visit);
  }, [visit, thread, execution.visits]);

  const latestOpen = conversationId === null;
  const anyOpen = runs.some((run, index) =>
    isRunOpen(expanded, run.taskRunId, index === runs.length - 1, latestOpen),
  );
  const setAll = (open: boolean) => {
    setExpanded(Object.fromEntries(runs.map((run) => [run.taskRunId, open])));
    if (!open) scrollRef.current?.scrollTo({ top: 0 });
  };

  const setDetails = (details: string | null) => {
    onNavigate({ details });
  };
  const openLogs = (runNumber: number | null) => {
    onNavigate({ view: "logs", run: runNumber, details: null });
  };
  const openVisitDetails = () => {
    if (visit) setDetails(visit.id);
  };

  useRunNavigationKeys(scrollRef, !inLogs && !detailsOpen);

  const showWork = (taskId: string) => {
    setExpanded((current) => ({ ...current, [taskId]: true }));
    setWorkTaskId(taskId);
  };
  useEffect(() => {
    if (workTaskId === null) return;
    const section = scrollRef.current?.querySelector<HTMLElement>(
      `[data-task-id="${workTaskId}"]`,
    );
    if (section && typeof section.scrollIntoView === "function") {
      section.scrollIntoView({ block: "start", behavior: "smooth" });
    }
    setWorkTaskId(null);
  }, [workTaskId]);

  const expandAllLink =
    runs.length > 1 ? (
      <TextLink
        onClick={() => {
          setAll(!anyOpen);
        }}
      >
        {anyOpen ? "Collapse all runs" : "Expand all runs"}
      </TextLink>
    ) : null;

  const body = (() => {
    if (!visit) {
      return (
        <Typography variant="body2" color="text.secondary">
          The run hasn&apos;t reached this node.
        </Typography>
      );
    }
    if (visit.nodeKind === "wait") {
      return (
        <WaitVisitPanel
          visit={visit}
          workItemId={execution.workItemId}
          controls={waitControls}
          onOpenDetails={openVisitDetails}
        />
      );
    }
    if (visit.nodeKind === "succeed" || visit.nodeKind === "fail") {
      return <EndNodePanel visit={visit} onOpenDetails={openVisitDetails} />;
    }
    const stepThread =
      runs.length > 0 ? (
        <StepThread
          runs={runs}
          expanded={expanded}
          onToggleRun={(taskId, open) => {
            setExpanded((current) => ({ ...current, [taskId]: open }));
          }}
          scrollRef={scrollRef}
          onQuote={canQuote ? setQuote : undefined}
          onOpenOutput={(run) => {
            setDetails(run.visitId ?? visit.id);
          }}
          onOpenLogs={(run) => {
            openLogs(run.runNumber);
          }}
          latestOpen={latestOpen}
        />
      ) : null;
    if (conversationId !== null) {
      return (
        <Stack spacing={4}>
          <ConversationPanel
            data={conversation}
            onShowWork={showWork}
            agentName={step.title}
          />
          {stepThread ? (
            <Box>
              <Stack
                direction="row"
                alignItems="baseline"
                justifyContent="space-between"
                sx={{ mb: 1 }}
              >
                <Typography variant="overline" color="text.secondary">
                  Attempts
                </Typography>
                {expandAllLink}
              </Stack>
              {stepThread}
            </Box>
          ) : null}
        </Stack>
      );
    }
    if (stepThread) return stepThread;
    if (thread.loading) {
      return (
        <Stack direction="row" spacing={1} alignItems="center">
          <CircularProgress size={14} />
          <Typography variant="body2" color="text.secondary">
            Loading conversation…
          </Typography>
        </Stack>
      );
    }
    return (
      <Typography variant="body2" color="text.secondary">
        No conversation captured yet.
      </Typography>
    );
  })();

  return (
    <Box
      sx={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}
    >
      {banner ? (
        <Box sx={{ px: { xs: 1.5, md: 3 }, pt: { xs: 2, md: 2 } }}>
          {banner}
        </Box>
      ) : null}
      {inLogs ? (
        <StepLogsView
          runs={runs}
          loading={thread.loading}
          runNumber={logsRunNumber}
          onRunChange={(run) => {
            onNavigate({ run });
          }}
          filter={logFilter}
          onFilterChange={(filter) => {
            onNavigate({ filter });
          }}
          fullScreen={fullScreen}
          onFullScreenChange={onFullScreenChange}
        />
      ) : (
        <>
          <ConversationScroller
            data={conversation}
            follow={conversationId !== null}
            scrollRef={scrollRef}
            testId="step-thread-scroll"
            px={{ xs: 1.5, md: 4 }}
          >
            <Box
              sx={{
                maxWidth: THREAD_COLUMN_WIDTH,
                mx: "auto",
                pt: 3,
                pb: 6,
              }}
            >
              {thread.error ? (
                <Alert severity="error" sx={{ mb: 2 }}>
                  {thread.error}
                </Alert>
              ) : null}
              {expandAllLink && conversationId === null ? (
                <Box
                  sx={{ display: "flex", justifyContent: "flex-end", mb: 1 }}
                >
                  {expandAllLink}
                </Box>
              ) : null}
              {body}
            </Box>
          </ConversationScroller>

          {replying || renderMessageBox ? (
            <Box sx={{ flexShrink: 0, px: { xs: 1.5, md: 4 } }}>
              <Box sx={{ maxWidth: THREAD_COLUMN_WIDTH, mx: "auto" }}>
                {replying ? (
                  <ConversationMessageBox
                    data={conversation}
                    agentName={step.title}
                  />
                ) : (
                  renderMessageBox?.({
                    quote,
                    onClearQuote: () => {
                      setQuote(null);
                    },
                  })
                )}
              </Box>
            </Box>
          ) : null}
        </>
      )}

      <StepDetailsDrawer
        execution={execution}
        visits={step.visits}
        visitId={detailsVisitId}
        onVisitChange={setDetails}
        onClose={() => {
          setDetails(null);
        }}
        focusArtifacts={focusArtifacts}
        onOpenLogs={openLogs}
        runOverview={runOverview}
        runNumberForTask={(taskId) =>
          runs.find((run) => run.taskRunId === taskId)?.runNumber ?? null
        }
      />
    </Box>
  );
}

/** Changes when the visit moves or its latest attempt starts or settles. */
const conversationRefreshKey = (visit: NodeVisitContract | null) => {
  if (!visit) return null;
  const task = latestVisitTask(visit);
  return `${visit.status}:${task?.taskId ?? ""}:${task?.status ?? ""}`;
};

const isTypingTarget = (target: EventTarget | null): boolean =>
  target instanceof Element &&
  target.closest("input, textarea, select, [contenteditable='true']") !== null;

/**
 * `[` and `]` scroll the thread to the previous / next run section's header.
 */
function useRunNavigationKeys(
  scrollRef: React.RefObject<HTMLElement | null>,
  enabled: boolean,
) {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "[" && event.key !== "]") return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;
      const container = scrollRef.current;
      if (!container) return;
      const sections = Array.from(
        container.querySelectorAll<HTMLElement>("[data-run-section]"),
      );
      const top = container.getBoundingClientRect().top;
      const offsets = sections.map(
        (section) => section.getBoundingClientRect().top - top,
      );
      const target =
        event.key === "]"
          ? sections.find((_, index) => (offsets[index] ?? 0) > 4)
          : sections.filter((_, index) => (offsets[index] ?? 0) < -4).at(-1);
      if (!target) return;
      event.preventDefault();
      if (typeof target.scrollIntoView === "function") {
        target.scrollIntoView({ block: "start" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [scrollRef, enabled]);
}
