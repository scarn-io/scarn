"use client";

/**
 * A step's conversation across every run of it (decision 1): one section per
 * task that ran the step, oldest first. Only expanded sections read their
 * task's `conversation` log stream (decision 2); collapsed sections show only
 * what the thread endpoint returns.
 */

import {
  Box,
  Button,
  CircularProgress,
  Stack,
  Typography,
} from "@mui/material";
import {
  Fragment,
  useEffect,
  useMemo,
  useState,
  type MouseEvent,
  type RefObject,
} from "react";
import { ThinkingIndicator } from "./conversation-parts";
import { formatElapsedMs } from "./elapsed";
import { formatClockTime } from "./format-datetime";
import { Prose } from "./prose";
import { QuoteButton } from "./quote-button";
import { RunArtifactsCard } from "./run-artifacts-card";
import {
  isRunLive,
  runCause,
  runDurationMs,
  runStatusWord,
  runTailIndicator,
  type StepThreadRun,
} from "./step-thread-model";
import { buildThreadItems, foldItems, startPrompt } from "./thread-items";
import {
  ActivityRow,
  SECTION_INDENT,
  SectionHeader,
  StartLine,
  TextLink,
} from "./thread-parts";
import { RunMessages, SessionNoteLine } from "./thread-question-parts";
import { useFollowScroll } from "./use-follow-scroll";
import { useTaskRunLogs } from "./use-task-run-logs";

/**
 * Explicit toggles win; otherwise only the latest run is open, unless
 * `latestOpen` is false (a conversation visit, whose chat comes first).
 */
export const isRunOpen = (
  expanded: Record<string, boolean>,
  taskId: string,
  latest: boolean,
  latestOpen = true,
): boolean => expanded[taskId] ?? (latest && latestOpen);

const NO_FOLLOW: RefObject<HTMLElement | null> = { current: null };

/** Re-renders every second while `ticking`, for live durations. */
function useNowMs(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    const id = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(id);
    };
  }, [ticking]);
  return now;
}

export function StepThread({
  runs,
  expanded,
  onToggleRun,
  scrollRef,
  onQuote,
  onOpenOutput,
  onOpenLogs,
  latestOpen = true,
}: {
  runs: StepThreadRun[];
  /** Explicit expand/collapse choices keyed by task id. */
  expanded: Record<string, boolean>;
  onToggleRun: (taskId: string, open: boolean) => void;
  /** The thread's scroll container; the latest run follows it while live. */
  scrollRef: RefObject<HTMLElement | null>;
  /** Absent when there's no message box to quote into. */
  onQuote?: (text: string) => void;
  onOpenOutput: (run: StepThreadRun) => void;
  onOpenLogs: (run: StepThreadRun) => void;
  /** Whether the latest run starts open; see `isRunOpen`. */
  latestOpen?: boolean;
}) {
  const nowMs = useNowMs(runs.some((run) => isRunLive(run.status)));
  return (
    <Box sx={{ position: "relative" }}>
      <Stack spacing={3}>
        {runs.map((run, index) => {
          const latest = index === runs.length - 1;
          return (
            <RunSection
              key={run.taskRunId}
              run={run}
              nowMs={nowMs}
              open={isRunOpen(expanded, run.taskRunId, latest, latestOpen)}
              onToggle={(open) => {
                onToggleRun(run.taskRunId, open);
              }}
              followRef={latest ? scrollRef : NO_FOLLOW}
              onOpenOutput={() => {
                onOpenOutput(run);
              }}
              onOpenLogs={() => {
                onOpenLogs(run);
              }}
            />
          );
        })}
      </Stack>
      {onQuote ? <QuoteButton onQuote={onQuote} /> : null}
    </Box>
  );
}

/** "Run N · cause · duration · status", the run section's header line. */
export function runHeaderParts(run: StepThreadRun, nowMs: number): string[] {
  const duration = runDurationMs(run, nowMs);
  return [
    runCause(run),
    duration === null ? "" : formatElapsedMs(duration),
    runStatusWord(run.status),
  ].filter(Boolean);
}

/**
 * One run of the step: the header (sticky while open) toggles between the
 * full conversation and a one-line summary.
 */
export function RunSection({
  run,
  nowMs,
  open,
  onToggle,
  followRef = NO_FOLLOW,
  onOpenOutput,
  onOpenLogs,
}: {
  run: StepThreadRun;
  nowMs: number;
  open: boolean;
  onToggle: (open: boolean) => void;
  followRef?: RefObject<HTMLElement | null>;
  onOpenOutput: () => void;
  onOpenLogs: () => void;
}) {
  const live = isRunLive(run.status);
  const startedAt = formatClockTime(run.startedAt);
  return (
    <Box data-run-section={run.runNumber} data-task-id={run.taskRunId}>
      <SectionHeader
        prominent
        sticky={open}
        open={open}
        onToggle={onToggle}
        leading={
          run.status === "running" ? (
            <CircularProgress size={12} thickness={5} sx={{ flexShrink: 0 }} />
          ) : null
        }
        meta={startedAt}
      >
        <Box component="span" sx={{ fontWeight: 600 }}>
          Run {run.runNumber}
        </Box>
        <Box component="span" sx={{ color: "text.secondary" }}>
          {" · "}
          {runHeaderParts(run, nowMs).join(" · ")}
        </Box>
      </SectionHeader>
      {open ? (
        <RunBody
          run={run}
          live={live}
          nowMs={nowMs}
          followRef={followRef}
          onOpenOutput={onOpenOutput}
          onOpenLogs={onOpenLogs}
        />
      ) : (
        <CollapsedRun
          run={run}
          onExpand={() => {
            onToggle(true);
          }}
        />
      )}
    </Box>
  );
}

/** Expand on click unless the click was a text selection or hit a control. */
const expandOnClick = (onExpand: () => void) => (event: MouseEvent) => {
  if (event.target instanceof Element && event.target.closest("button, a"))
    return;
  if (window.getSelection()?.toString()) return;
  onExpand();
};

function CollapsedRun({
  run,
  onExpand,
}: {
  run: StepThreadRun;
  onExpand: () => void;
}) {
  const message = run.messages.at(-1);
  const stopped = run.status === "cancelled";
  if (!message && !stopped) return null;
  return (
    <Stack
      spacing={0.75}
      onClick={expandOnClick(onExpand)}
      sx={{ pl: SECTION_INDENT, pt: 0.75, cursor: "pointer" }}
    >
      {message ? (
        <Typography
          variant="body2"
          sx={{
            color: "primary.light",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {`You: “${message.body}”`}
        </Typography>
      ) : null}
      {stopped ? (
        <Typography variant="body2" sx={{ color: "text.disabled" }}>
          Stopped: a newer run was started.
        </Typography>
      ) : null}
    </Stack>
  );
}

function RunBody({
  run,
  live,
  nowMs,
  followRef,
  onOpenOutput,
  onOpenLogs,
}: {
  run: StepThreadRun;
  live: boolean;
  nowMs: number;
  followRef: RefObject<HTMLElement | null>;
  onOpenOutput: () => void;
  onOpenLogs: () => void;
}) {
  const logs = useTaskRunLogs(run.taskRunId, live);
  const events = logs.conversationEvents;
  const items = useMemo(
    () => buildThreadItems(events, { running: live }),
    [events, live],
  );
  const prompt = useMemo(() => startPrompt(events), [events]);
  const [unfolded, setUnfolded] = useState(false);
  const foldable = foldItems(items);
  const fold = unfolded ? null : foldable;
  const { unseen, jumpToLatest } = useFollowScroll(followRef, events.length);

  // `useTaskRunLogs` reports `loading: false` before its first fetch starts, so
  // "nothing captured" waits until a load has actually been seen.
  const [sawLoading, setSawLoading] = useState(false);
  if (logs.loading && !sawLoading) setSawLoading(true);
  const settled = logs.complete || (sawLoading && !logs.loading);
  const showLoading = !live && !settled && !logs.error && events.length === 0;
  const showEmpty = !live && settled && !logs.error && events.length === 0;
  const trailingEndMs = run.completedAt ? Date.parse(run.completedAt) : nowMs;
  const lastItem = items.at(-1);
  const duration = runDurationMs(run, nowMs);
  const startedAt = formatClockTime(run.startedAt);
  const tail = runTailIndicator({
    status: run.status,
    hasConversation: events.length > 0,
    activityActive: lastItem?.type === "activity" && lastItem.active,
  });

  return (
    <Stack spacing={2.5} sx={{ pt: 1.5 }}>
      <RunMessages run={run} />
      <StartLine prompt={prompt}>
        {runCause(run)}
        {startedAt ? ` · ${startedAt}` : ""}
      </StartLine>
      <SessionNoteLine run={run} />
      {items.map((item, index) => {
        if (fold && index < fold.visibleFrom) return null;
        return (
          <Fragment key={item.id}>
            {foldable && index === (fold ? fold.visibleFrom : 0) ? (
              <SectionHeader open={unfolded} onToggle={setUnfolded}>
                {unfolded
                  ? "Hide earlier updates"
                  : `${String(foldable.hidden)} earlier updates${
                      foldable.durationMs !== null &&
                      foldable.durationMs >= 1000
                        ? ` · ${formatElapsedMs(foldable.durationMs)}`
                        : ""
                    }`}
              </SectionHeader>
            ) : null}
            {item.type === "narration" ? (
              <Box data-quotable>
                <Prose text={item.text} />
              </Box>
            ) : null}
            {item.type === "activity" ? (
              <ActivityRow item={item} endMs={trailingEndMs} />
            ) : null}
            {item.type === "session-error" ? (
              <Typography
                variant="body2"
                color="error.main"
                sx={{ whiteSpace: "pre-wrap" }}
              >
                {item.message}
              </Typography>
            ) : null}
          </Fragment>
        );
      })}
      {logs.error ? (
        <Typography variant="body2" color="error.main">
          {logs.error}
        </Typography>
      ) : null}
      {showLoading ? (
        <Typography variant="body2" color="text.secondary">
          Loading conversation…
        </Typography>
      ) : null}
      {showEmpty ? (
        <Typography variant="body2" color="text.secondary">
          No conversation captured ·{" "}
          <TextLink onClick={onOpenLogs}>Open logs</TextLink>
        </Typography>
      ) : null}
      {tail === "thinking" ? (
        <Box sx={{ ml: -1.5 }}>
          <ThinkingIndicator />
        </Box>
      ) : null}
      {tail === "spinning-up" ? (
        <Stack direction="row" alignItems="baseline" sx={{ ml: -1.5 }}>
          <ThinkingIndicator label="Spinning up agent…" />
          <TextLink onClick={onOpenLogs}>See logs</TextLink>
        </Stack>
      ) : null}
      {!live ? <RunArtifactsCard taskRunId={run.taskRunId} /> : null}
      {run.status === "cancelled" ? (
        <Typography variant="body2" color="text.secondary">
          Stopped: a newer run was started ·{" "}
          <TextLink onClick={onOpenLogs}>View logs</TextLink>
        </Typography>
      ) : null}
      {!live && run.status !== "cancelled" ? (
        <Typography variant="body2" sx={{ color: "text.disabled" }}>
          {duration === null ? "" : `${formatElapsedMs(duration)} · `}
          <TextLink onClick={onOpenOutput}>Output</TextLink>
          {" · "}
          <TextLink onClick={onOpenLogs}>Logs</TextLink>
        </Typography>
      ) : null}
      {unseen > 0 ? (
        <Box
          sx={{
            position: "sticky",
            bottom: 8,
            display: "flex",
            justifyContent: "center",
            pointerEvents: "none",
          }}
        >
          <Button
            size="small"
            variant="contained"
            color="inherit"
            onClick={jumpToLatest}
            sx={{ pointerEvents: "auto", borderRadius: 4 }}
          >
            New updates ↓
          </Button>
        </Box>
      ) : null}
    </Stack>
  );
}
