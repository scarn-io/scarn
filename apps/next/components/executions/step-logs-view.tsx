"use client";

/**
 * The step page's Logs view (decision 5): one run's raw log lines, using the
 * whole main area. A toolbar (run picker, stream filter, Live chip, line and
 * warning counts, timestamps, full screen) sits over `LogViewer`, which
 * scrolls in its own container. Full screen hides the header and the rail;
 * Esc restores them.
 */

import {
  Box,
  Chip,
  CircularProgress,
  IconButton,
  MenuItem,
  Select,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import CloseFullscreenIcon from "@mui/icons-material/CloseFullscreen";
import OpenInFullIcon from "@mui/icons-material/OpenInFull";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatClockTime } from "./format-datetime";
import { LogViewer, filterLogLines, type LogStreamFilter } from "./log-viewer";
import {
  isRunLive,
  runStatusWord,
  type StepThreadRun,
} from "./step-thread-model";
import { useTaskRunLogs } from "./use-task-run-logs";

const FILTERS: { value: LogStreamFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "worker", label: "Worker" },
  { value: "ai-server", label: "AI server" },
];

/** The run `?run=` names, or the latest run when it names none. */
export function selectLogsRun(
  runs: readonly StepThreadRun[],
  runNumber: number | null,
): StepThreadRun | null {
  return runs.find((run) => run.runNumber === runNumber) ?? runs.at(-1) ?? null;
}

export function StepLogsView({
  runs,
  loading,
  runNumber,
  onRunChange,
  filter,
  onFilterChange,
  fullScreen,
  onFullScreenChange,
}: {
  /** The step's runs, oldest first. */
  runs: readonly StepThreadRun[];
  /** The runs are still loading. */
  loading: boolean;
  /** `?run=`; `null` shows the latest run. */
  runNumber: number | null;
  onRunChange: (runNumber: number) => void;
  filter: LogStreamFilter;
  onFilterChange: (filter: LogStreamFilter) => void;
  fullScreen: boolean;
  onFullScreenChange: (fullScreen: boolean) => void;
}) {
  const run = selectLogsRun(runs, runNumber);

  useEffect(() => {
    if (!fullScreen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onFullScreenChange(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [fullScreen, onFullScreenChange]);

  if (!run) {
    return (
      <Box sx={{ px: { xs: 1.5, md: 3 }, py: 3 }}>
        {loading ? (
          <Stack direction="row" spacing={1} alignItems="center">
            <CircularProgress size={14} />
            <Typography variant="body2" color="text.secondary">
              Loading runs…
            </Typography>
          </Stack>
        ) : (
          <Typography variant="body2" color="text.secondary">
            This visit has no logs: it hasn&apos;t run a task.
          </Typography>
        )}
      </Box>
    );
  }

  return (
    <RunLogs
      key={run.taskRunId}
      runs={runs}
      run={run}
      onRunChange={onRunChange}
      filter={filter}
      onFilterChange={onFilterChange}
      fullScreen={fullScreen}
      onFullScreenChange={onFullScreenChange}
    />
  );
}

function RunLogs({
  runs,
  run,
  onRunChange,
  filter,
  onFilterChange,
  fullScreen,
  onFullScreenChange,
}: {
  runs: readonly StepThreadRun[];
  run: StepThreadRun;
  onRunChange: (runNumber: number) => void;
  filter: LogStreamFilter;
  onFilterChange: (filter: LogStreamFilter) => void;
  fullScreen: boolean;
  onFullScreenChange: (fullScreen: boolean) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showTimestamps, setShowTimestamps] = useState(false);
  const live = isRunLive(run.status);
  const logs = useTaskRunLogs(run.taskRunId, live);
  const lineCount = useMemo(
    () => filterLogLines(logs.lines, filter).length,
    [logs.lines, filter],
  );
  const warnings = useMemo(
    () => logs.lines.filter((line) => line.level === "warn").length,
    [logs.lines],
  );
  const latestRunNumber = runs.at(-1)?.runNumber;

  return (
    <Box
      sx={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <Stack
        direction="row"
        alignItems="center"
        spacing={1}
        useFlexGap
        flexWrap="wrap"
        sx={{
          px: { xs: 1.5, md: 2 },
          py: 1,
          flexShrink: 0,
          borderBottom: 1,
          borderColor: "divider",
        }}
      >
        <Select
          size="small"
          value={run.runNumber}
          onChange={(event) => {
            onRunChange(event.target.value);
          }}
          inputProps={{ "aria-label": "Logs run" }}
          sx={{
            fontSize: 13,
            minWidth: 200,
            "& .MuiSelect-select": { py: 0.5 },
          }}
        >
          {[...runs].reverse().map((candidate) => {
            const startedAt = formatClockTime(candidate.startedAt);
            return (
              <MenuItem
                key={candidate.taskRunId}
                value={candidate.runNumber}
                sx={{ fontSize: 13 }}
              >
                Run {candidate.runNumber}
                <Box component="span" sx={{ color: "text.secondary" }}>
                  &nbsp;· {startedAt ?? runStatusWord(candidate.status)}
                  {candidate.runNumber === latestRunNumber ? " · latest" : ""}
                </Box>
              </MenuItem>
            );
          })}
        </Select>
        <Stack direction="row" spacing={0.5} role="group" aria-label="Streams">
          {FILTERS.map((option) => {
            const selected = filter === option.value;
            return (
              <Chip
                key={option.value}
                size="small"
                label={option.label}
                clickable
                aria-pressed={selected}
                variant={selected ? "filled" : "outlined"}
                onClick={() => {
                  onFilterChange(option.value);
                }}
              />
            );
          })}
        </Stack>
        <Box sx={{ flex: 1 }} />
        {live && !logs.complete ? (
          <Chip size="small" color="info" label="Live" />
        ) : null}
        <Typography
          variant="caption"
          sx={{ color: "text.disabled", whiteSpace: "nowrap" }}
        >
          {lineCount} {lineCount === 1 ? "line" : "lines"}
          {warnings > 0
            ? ` · ${String(warnings)} ${warnings === 1 ? "warning" : "warnings"}`
            : ""}
        </Typography>
        <Chip
          size="small"
          label="Timestamps"
          clickable
          aria-pressed={showTimestamps}
          variant={showTimestamps ? "filled" : "outlined"}
          onClick={() => {
            setShowTimestamps((shown) => !shown);
          }}
        />
        <Tooltip
          title={fullScreen ? "Exit full screen (Esc)" : "Full screen"}
          disableInteractive
        >
          <IconButton
            size="small"
            onClick={() => {
              onFullScreenChange(!fullScreen);
            }}
            aria-label={fullScreen ? "Exit full screen" : "Full screen"}
            sx={{ color: "text.secondary" }}
          >
            {fullScreen ? (
              <CloseFullscreenIcon fontSize="small" />
            ) : (
              <OpenInFullIcon fontSize="small" />
            )}
          </IconButton>
        </Tooltip>
      </Stack>

      <Box
        ref={scrollRef}
        data-testid="step-logs-scroll"
        sx={{ flex: 1, minHeight: 0, overflow: "auto" }}
      >
        <LogViewer
          logs={logs}
          active={live}
          filter={filter}
          showTimestamps={showTimestamps}
          scrollRef={scrollRef}
        />
      </Box>
    </Box>
  );
}
