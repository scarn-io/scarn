"use client";

import { useMemo, type RefObject } from "react";
import { alpha, Box, Chip, Typography } from "@mui/material";
import KeyboardArrowDownIcon from "@mui/icons-material/KeyboardArrowDown";
import type {
  LogLineContract,
  TaskLogStream,
} from "@scarn/api/frontend-contracts";
import type { TaskRunLogsData } from "./use-task-run-logs";
import { formatDateTime } from "./format-datetime";
import { useFollowScroll } from "./use-follow-scroll";

/**
 * Filter applied to the raw log feed. `all` shows every stream (including the
 * structured `conversation` stream as the raw JSON it is persisted as); `worker`
 * and `ai-server` show a single source.
 */
export type LogStreamFilter = "all" | "worker" | "ai-server";

/** Human-readable label for each persisted stream. */
const STREAM_LABELS: Record<TaskLogStream, string> = {
  worker: "worker",
  "ai-server": "ai server",
  conversation: "agent",
};

const STREAM_COLORS: Record<TaskLogStream, string> = {
  worker: "info.main",
  "ai-server": "success.main",
  conversation: "secondary.main",
};

/**
 * Severity is derived from the structured `level` the worker assigns at the
 * source and which is persisted through the feed and archive — not from the
 * message text. `error` and `warn` are surfaced; `debug`/`info` render normally.
 * (Archives predating persisted levels default to `info` on read.)
 */
type LogSeverity = "error" | "warning" | "normal";

function classifySeverity(line: LogLineContract): LogSeverity {
  if (line.level === "error") return "error";
  if (line.level === "warn") return "warning";
  return "normal";
}

/** The lines `filter` shows. */
export function filterLogLines(
  lines: LogLineContract[],
  filter: LogStreamFilter,
): LogLineContract[] {
  // `all` shows every stream verbatim, including the structured
  // `conversation` stream as the raw JSON it is persisted as.
  if (filter === "all") return lines;
  return lines.filter((line) => line.stream === filter);
}

/**
 * Live, auto-scrolling, timestamped log lines for a task. Tails the server
 * feed while the step is active and shows the durable archive once complete.
 * The lines flow inside the caller's `scrollRef` container, which follows new
 * lines while pinned to its bottom (`useFollowScroll`); the "N new lines" chip
 * sticks to that container's bottom edge.
 */
export function LogViewer({
  logs,
  active,
  filter,
  showTimestamps = false,
  scrollRef,
}: {
  logs: TaskRunLogsData;
  active: boolean;
  filter: LogStreamFilter;
  showTimestamps?: boolean;
  /** The scroll container the log body flows in; auto-tail follows it. */
  scrollRef: RefObject<HTMLElement | null>;
}) {
  const { lines, loading, complete, error } = logs;

  const visibleLines = useMemo(
    () => filterLogLines(lines, filter),
    [lines, filter],
  );

  const { unseen, jumpToLatest } = useFollowScroll(
    scrollRef,
    visibleLines.length,
    { initiallyPinned: active },
  );

  const showJumpToLatest = active && !complete && unseen > 0;

  return (
    <Box>
      {error && visibleLines.length > 0 ? (
        <Typography variant="body2" color="error.main" sx={{ px: 2, py: 1 }}>
          {error}
        </Typography>
      ) : null}

      <Box
        sx={{
          py: 1,
          fontFamily: "var(--font-mono)",
          fontSize: 12.5,
          lineHeight: 1.6,
        }}
      >
        {visibleLines.length === 0 ? (
          <Typography
            variant="body2"
            color={error ? "error.main" : "text.secondary"}
            sx={{ px: 2, py: 1 }}
          >
            {error
              ? error
              : loading
                ? "Loading logs…"
                : complete
                  ? "No logs for this stream."
                  : "No logs yet."}
          </Typography>
        ) : (
          visibleLines.map((line, index) => (
            <LogRow
              key={`${line.stream}-${String(line.seq)}`}
              line={line}
              lineNumber={index + 1}
              showTimestamp={showTimestamps}
            />
          ))
        )}
      </Box>

      {showJumpToLatest ? (
        <Box
          sx={{
            position: "sticky",
            bottom: 16,
            display: "flex",
            justifyContent: "center",
            pointerEvents: "none",
          }}
        >
          <Chip
            icon={<KeyboardArrowDownIcon />}
            color="primary"
            clickable
            onClick={jumpToLatest}
            aria-label="Jump to latest logs"
            label={unseen === 1 ? "1 new line" : `${String(unseen)} new lines`}
            sx={{ pointerEvents: "auto", boxShadow: 3, fontWeight: 600 }}
          />
        </Box>
      ) : null}
    </Box>
  );
}

function LogRow({
  line,
  lineNumber,
  showTimestamp,
}: {
  line: LogLineContract;
  lineNumber: number;
  showTimestamp: boolean;
}) {
  const streamColor = STREAM_COLORS[line.stream];
  const severity = classifySeverity(line);
  const isFlagged = severity !== "normal";
  // Match GitHub Actions: instead of coloring the whole message red (which is
  // hard to read against a dark terminal), flagged rows get a subtle tinted
  // background, a colored left-border accent, and a bold "Error:"/"Warning:"
  // prefix — while the message text itself stays at normal readability.
  const accentColor = severity === "warning" ? "warning.main" : "error.main";
  const severityLabel = severity === "warning" ? "Warning:" : "Error:";
  return (
    <Box
      component="div"
      sx={{
        display: "grid",
        // A fixed line-number gutter, an optional timestamp column (toggled by
        // the "Show timestamps" control and hidden on mobile), and the message
        // column. The stream label lives inline at the start of the message
        // (rendered once), so it stays visible at every breakpoint without a
        // duplicate fixed column.
        gridTemplateColumns: showTimestamp
          ? { xs: "32px 1fr", sm: "36px auto 1fr" }
          : "32px 1fr",
        columnGap: 1.5,
        px: { xs: 1.5, sm: 2 },
        whiteSpace: "pre-wrap",
        overflowWrap: "anywhere",
        ...(isFlagged
          ? {
              // A very subtle tinted band plus a left accent bar; the 3px inset
              // accent is drawn via box-shadow so it doesn't shift the grid
              // columns. Kept low-alpha to match GitHub's understated look.
              backgroundColor: (theme) =>
                alpha(
                  theme.palette[severity === "warning" ? "warning" : "error"]
                    .main,
                  0.06,
                ),
              boxShadow: (theme) =>
                `inset 3px 0 0 0 ${theme.palette[severity === "warning" ? "warning" : "error"].main}`,
            }
          : {}),
        "&:hover": {
          backgroundColor: isFlagged
            ? (theme) =>
                alpha(
                  theme.palette[severity === "warning" ? "warning" : "error"]
                    .main,
                  0.1,
                )
            : "action.hover",
        },
      }}
    >
      <Box
        component="span"
        aria-hidden
        sx={{
          color: isFlagged ? accentColor : "text.disabled",
          textAlign: "right",
          userSelect: "none",
        }}
      >
        {lineNumber}
      </Box>
      {showTimestamp ? (
        <Box
          component="span"
          sx={{
            color: "text.disabled",
            display: { xs: "none", sm: "block" },
            whiteSpace: "nowrap",
          }}
        >
          {formatDateTime(line.ts)}
        </Box>
      ) : null}
      <Box
        component="span"
        // On flagged rows the message text is muted to a gray so it reads as
        // secondary to the bold red severity prefix (mirroring GitHub Actions),
        // while normal rows keep the default terminal foreground.
        sx={{ minWidth: 0, color: isFlagged ? "text.secondary" : undefined }}
      >
        <Box
          component="span"
          sx={{ color: streamColor, fontWeight: 600, mr: 1 }}
        >
          {STREAM_LABELS[line.stream]}
        </Box>
        {isFlagged ? (
          <Box
            component="span"
            sx={{ color: accentColor, fontWeight: 700, mr: 0.75 }}
          >
            {severityLabel}
          </Box>
        ) : null}
        {line.content}
      </Box>
    </Box>
  );
}
