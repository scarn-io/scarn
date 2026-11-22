import type {
  PipelineExecutionContract,
  PipelineRunStatus,
  WorkItemAssigneeContract,
  WorkItemListItemContract,
  WorkItemTaskStatusCounts,
} from "@scarn/api/frontend-contracts";
import {
  Chip,
  Link as MuiLink,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from "@mui/material";
import PendingActionsIcon from "@mui/icons-material/PendingActions";
import { RecordListEmpty } from "@/components/common/record-list/record-list-empty";
import {
  describeFilter,
  type WorkItemFilter,
} from "@/components/work-items/filters/work-item-filter-model";
import type { WorkItemSort } from "@/components/work-items/project-work-items-params";
import {
  ExecutionStatusIcon,
  getExecutionStatusColor,
  getExecutionStatusLabel,
} from "@/components/executions/execution-status-icon";
import {
  formatDateTime,
  formatRelativeTime,
} from "@/components/executions/format-datetime";
import {
  MemberAvatar,
  memberLabel,
} from "@/components/work-items/work-item-assignee";

/**
 * `latestExecutionStatus` crosses the work-items/pipeline-executions module
 * boundary as the latest run's stored status in a plain `string | null` (see
 * `workItemListItemSchema`). It is mapped onto the display statuses
 * `ExecutionStatusIcon` speaks — a stored `active` run reads as running. An
 * unrecognized value renders the neutral "no value" state instead of crashing.
 */
type ExecutionStatus = PipelineExecutionContract["status"];

const LATEST_RUN_DISPLAY_STATUS: Record<PipelineRunStatus, ExecutionStatus> = {
  active: "running",
  waiting: "waiting",
  succeeded: "succeeded",
  failed: "failed",
  cancelled: "cancelled",
};

const latestRunDisplayStatus = (
  value: string | null,
): ExecutionStatus | null =>
  value !== null && Object.hasOwn(LATEST_RUN_DISPLAY_STATUS, value)
    ? LATEST_RUN_DISPLAY_STATUS[value as PipelineRunStatus]
    : null;

type TaskChip = {
  label: string;
  color: "error" | "warning" | "info" | "default";
};

/**
 * The Agent column's chips, most urgent first. `waitingForPerson` includes
 * the Tasks waiting on the viewer, so those are subtracted out of the generic
 * "waiting" chip rather than counted twice.
 */
export const taskStatusChips = (counts: WorkItemTaskStatusCounts): TaskChip[] =>
  [
    {
      count: counts.waitingOnYou,
      label: "waiting on you",
      color: "error" as const,
    },
    {
      count: counts.waitingForPerson - counts.waitingOnYou,
      label: "waiting",
      color: "warning" as const,
    },
    { count: counts.failed, label: "failed", color: "error" as const },
    { count: counts.running, label: "running", color: "info" as const },
    { count: counts.queued, label: "queued", color: "default" as const },
    {
      count: counts.waitingForWork,
      label: "blocked",
      color: "default" as const,
    },
  ]
    .filter((chip) => chip.count > 0)
    .map((chip) => ({
      label: `${String(chip.count)} ${chip.label}`,
      color: chip.color,
    }));

const EMPTY_CELL = (
  <Typography variant="body2" color="text.secondary">
    —
  </Typography>
);

function AssigneeCell({
  assignee,
}: {
  assignee: WorkItemAssigneeContract | null;
}) {
  if (!assignee) return EMPTY_CELL;
  return (
    <Stack direction="row" spacing={0.75} alignItems="center">
      <MemberAvatar member={assignee} />
      <Typography variant="body2" noWrap sx={{ maxWidth: 140 }}>
        {memberLabel(assignee)}
      </Typography>
    </Stack>
  );
}

function AgentCell({ counts }: { counts: WorkItemTaskStatusCounts }) {
  const chips = taskStatusChips(counts);
  if (chips.length === 0) return EMPTY_CELL;
  return (
    <Stack direction="row" spacing={0.5} useFlexGap flexWrap="wrap">
      {chips.map((chip) => (
        <Chip
          key={chip.label}
          label={chip.label}
          color={chip.color}
          size="small"
          variant={chip.color === "default" ? "outlined" : "filled"}
        />
      ))}
    </Stack>
  );
}

/**
 * Neutral label chips beside the title. Clicking one narrows the list to that
 * label; without a handler they render as plain, unclickable chips.
 */
export function WorkItemLabelChips({
  labels,
  onLabelClick,
}: {
  labels: readonly string[];
  onLabelClick?: (label: string) => void;
}) {
  if (labels.length === 0) return null;
  return (
    <Stack
      direction="row"
      spacing={0.5}
      useFlexGap
      flexWrap="wrap"
      sx={{ display: "inline-flex", ml: 1, verticalAlign: "middle" }}
    >
      {labels.map((label) => (
        <Chip
          key={label}
          label={label}
          size="small"
          variant="outlined"
          aria-label={onLabelClick ? `Filter by label ${label}` : undefined}
          onClick={
            onLabelClick
              ? () => {
                  onLabelClick(label);
                }
              : undefined
          }
          sx={{ height: 20, fontSize: "0.7rem", color: "text.secondary" }}
        />
      ))}
    </Stack>
  );
}

const truncateDescription = (value: string, maxLength = 160) =>
  value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}...`;

/**
 * Presence-based, not the raw count: one pending draft is the overwhelming
 * common case, and `Awaiting approval (1)` would be noise where a bare
 * `Awaiting approval` reads cleanly. The number only earns its place once
 * there's more than one to disambiguate.
 */
const awaitingApprovalLabel = (count: number): string =>
  count > 1 ? `Awaiting approval (${String(count)})` : "Awaiting approval";

/** Mono, tabular styling for machine-ish values (keys, timestamps, scores). */
const MONO_CELL_SX = {
  fontFamily: "var(--font-mono)",
  fontSize: "0.75rem",
  whiteSpace: "nowrap" as const,
  color: "text.secondary",
};

const NOWRAP_HEAD_SX = { whiteSpace: "nowrap" as const };

export function WorkItemsTable({
  workItems,
  workItemHrefPrefix,
  sort,
  scores,
  scoreLabel,
  filters = [],
  onRemoveFilter,
  onLabelClick,
}: {
  workItems: WorkItemListItemContract[];
  workItemHrefPrefix: string;
  /** The active sort, so the row can surface the clock it's actually ordered
   * by (decision 11, `docs/plans/work-item-sort.md`) rather than always
   * reading as if it were sorted by update time. */
  sort?: WorkItemSort;
  scores?: Map<string, number>;
  scoreLabel?: string;
  /** Active clauses, so an empty result can name one worth dropping. */
  filters?: WorkItemFilter[];
  onRemoveFilter?: (filter: WorkItemFilter) => void;
  /** Narrow the list to a label clicked on a row. */
  onLabelClick?: (label: string) => void;
}) {
  // Visibility is the caller's decision: it passes `scores` only when a signal
  // sort is active. Deriving it from `scores.size > 0` would hide the column on
  // any page where every item happens to be unscored.
  const showScoreColumn = scores !== undefined;
  const columnLabel = scoreLabel ?? "Score";
  // "Source Updated"/"Synced" already show unconditionally; sorting by
  // "Created" is the one axis with no clock in the row at all, so its column
  // only earns its place once that's what the list is actually ordered by.
  const showCreatedColumn = sort?.kind === "created";

  if (workItems.length === 0) {
    // A suggestion, not a history: clause order comes from the URL grammar, so
    // which clause the user added last is not recoverable. The trailing clause
    // in that fixed order is a stable, reproducible thing to offer, and the
    // copy promises no more than that.
    const suggestion = filters.at(-1);
    return (
      <Paper>
        <RecordListEmpty
          title="No work items match your filters"
          description={
            suggestion
              ? "Try removing a filter to broaden the results."
              : "Adjust the search or sort criteria to broaden the results."
          }
          action={
            suggestion && onRemoveFilter ? (
              <Chip
                variant="outlined"
                label={`Remove ${describeFilter(suggestion).label}`}
                onClick={() => {
                  onRemoveFilter(suggestion);
                }}
              />
            ) : undefined
          }
        />
      </Paper>
    );
  }

  return (
    <TableContainer component={Paper}>
      <Table>
        <TableHead>
          <TableRow>
            <TableCell>Title</TableCell>
            <TableCell sx={NOWRAP_HEAD_SX}>Agent</TableCell>
            <TableCell sx={NOWRAP_HEAD_SX}>Assignee</TableCell>
            <TableCell sx={NOWRAP_HEAD_SX}>Latest run</TableCell>
            <TableCell sx={NOWRAP_HEAD_SX}>Platform</TableCell>
            <TableCell sx={NOWRAP_HEAD_SX}>Key</TableCell>
            {showCreatedColumn && (
              <TableCell sx={NOWRAP_HEAD_SX}>Created</TableCell>
            )}
            <TableCell sx={NOWRAP_HEAD_SX}>Source Updated</TableCell>
            <TableCell sx={NOWRAP_HEAD_SX}>Synced</TableCell>
            {showScoreColumn && (
              <TableCell sx={NOWRAP_HEAD_SX}>{columnLabel}</TableCell>
            )}
          </TableRow>
        </TableHead>
        <TableBody>
          {workItems.map((workItem) => {
            const status = latestRunDisplayStatus(
              workItem.latestExecutionStatus,
            );

            return (
              <TableRow key={workItem.id} hover>
                <TableCell sx={{ minWidth: 320 }}>
                  <MuiLink
                    href={`${workItemHrefPrefix}/${workItem.id}`}
                    underline="hover"
                    color="inherit"
                  >
                    {workItem.title}
                  </MuiLink>
                  <WorkItemLabelChips
                    labels={workItem.labels}
                    onLabelClick={onLabelClick}
                  />
                  <Typography
                    variant="body2"
                    color="text.secondary"
                    sx={{
                      mt: 0.5,
                      overflowWrap: "anywhere",
                      wordBreak: "break-word",
                    }}
                  >
                    {truncateDescription(workItem.description)}
                  </Typography>
                  {workItem.awaitingApprovalCount > 0 && (
                    <Stack
                      direction="row"
                      spacing={0.5}
                      alignItems="center"
                      sx={{ mt: 0.5, color: "warning.main" }}
                    >
                      <PendingActionsIcon sx={{ fontSize: 14 }} />
                      <Typography
                        variant="caption"
                        sx={{ fontWeight: 700, letterSpacing: "0.01em" }}
                      >
                        {awaitingApprovalLabel(workItem.awaitingApprovalCount)}
                      </Typography>
                    </Stack>
                  )}
                </TableCell>
                <TableCell sx={{ minWidth: 120 }}>
                  <AgentCell counts={workItem.taskStatusCounts} />
                </TableCell>
                <TableCell sx={{ whiteSpace: "nowrap" }}>
                  <AssigneeCell assignee={workItem.assignee} />
                </TableCell>
                <TableCell sx={{ whiteSpace: "nowrap" }}>
                  {status ? (
                    <Stack direction="row" spacing={0.75} alignItems="center">
                      <ExecutionStatusIcon status={status} />
                      <Typography
                        variant="body2"
                        color={getExecutionStatusColor(status)}
                      >
                        {getExecutionStatusLabel(status)}
                      </Typography>
                    </Stack>
                  ) : (
                    EMPTY_CELL
                  )}
                </TableCell>
                <TableCell sx={{ whiteSpace: "nowrap" }}>
                  {workItem.platform}
                </TableCell>
                <TableCell sx={MONO_CELL_SX}>
                  {workItem.url ? (
                    <MuiLink
                      href={workItem.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {workItem.platformKey}
                    </MuiLink>
                  ) : (
                    workItem.platformKey
                  )}
                </TableCell>
                {showCreatedColumn && (
                  <TableCell
                    sx={{ whiteSpace: "nowrap", color: "text.secondary" }}
                  >
                    <Tooltip
                      title={formatDateTime(
                        workItem.sourceCreatedAt ?? workItem.createdAt,
                      )}
                    >
                      <span>
                        {formatRelativeTime(
                          workItem.sourceCreatedAt ?? workItem.createdAt,
                        )}
                      </span>
                    </Tooltip>
                  </TableCell>
                )}
                <TableCell
                  sx={{ whiteSpace: "nowrap", color: "text.secondary" }}
                >
                  <Tooltip title={formatDateTime(workItem.sourceUpdatedAt)}>
                    <span>{formatRelativeTime(workItem.sourceUpdatedAt)}</span>
                  </Tooltip>
                </TableCell>
                <TableCell
                  sx={{ whiteSpace: "nowrap", color: "text.secondary" }}
                >
                  <Tooltip title={formatDateTime(workItem.updatedAt)}>
                    <span>{formatRelativeTime(workItem.updatedAt)}</span>
                  </Tooltip>
                </TableCell>
                {showScoreColumn && (
                  <TableCell sx={{ ...MONO_CELL_SX, color: "text.primary" }}>
                    {scores.has(workItem.id)
                      ? (scores.get(workItem.id) as number).toFixed(3)
                      : "—"}
                  </TableCell>
                )}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </TableContainer>
  );
}
