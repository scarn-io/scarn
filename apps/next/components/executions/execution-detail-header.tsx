"use client";

/**
 * The pipeline run page's header: the shared {@link RunHeader} (breadcrumb,
 * title, status pill, caption) carrying the run's actions — Re-run from
 * start, Details and a `⋯` menu for rerunning the selected visit — over a
 * step bar naming the selected step with its Conversation | Logs toggle.
 */

import ReplayIcon from "@mui/icons-material/Replay";
import MoreHorizIcon from "@mui/icons-material/MoreHoriz";
import ViewSidebarOutlinedIcon from "@mui/icons-material/ViewSidebarOutlined";
import {
  Box,
  Button,
  IconButton,
  Menu,
  MenuItem,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import { useMenu } from "@/components/common/use-menu";
import { RunHeader, type RunHeaderProps } from "@/components/runs/run-header";
import type { ExecutionHeaderStep } from "./execution-header-step";
import {
  StepRunStatusIcon,
  getStepRunStatusLabel,
} from "./step-run-status-icon";
import { StepViewToggle } from "./step-view-toggle";

const truncateSx = {
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
} as const;

export type ExecutionDetailHeaderProps = Pick<
  RunHeaderProps,
  "run" | "viewerUserId" | "stepsSoFar" | "placesAtOnce"
> & {
  /** The title while the run's row is not loaded (or is not a row). */
  fallbackTitle: string;
  /** Reruns the whole run from its first visit; `null` when it can't be. */
  onRerun: (() => void) | null;
  rerunDisabled: boolean;
  /** Rerun is a write action — hidden for a non-member viewer of a public
   * project (issue #150). */
  canRerun?: boolean;
  pendingActionLabel: string;
  detailsOpen: boolean;
  onToggleDetails: () => void;
  step?: ExecutionHeaderStep | null;
};

export function ExecutionDetailHeader({
  run,
  viewerUserId,
  stepsSoFar,
  placesAtOnce,
  fallbackTitle,
  onRerun,
  rerunDisabled,
  canRerun = true,
  pendingActionLabel,
  detailsOpen,
  onToggleDetails,
  step = null,
}: ExecutionDetailHeaderProps) {
  const rerunMenu = useMenu();
  const stepRerun = step?.onRerun ?? null;

  const actions = (
    <>
      {pendingActionLabel ? (
        <Typography
          variant="body2"
          color="text.secondary"
          sx={{ whiteSpace: "nowrap" }}
        >
          {pendingActionLabel}
        </Typography>
      ) : null}
      {canRerun && onRerun ? (
        <Button
          variant="outlined"
          size="small"
          disabled={rerunDisabled}
          startIcon={<ReplayIcon fontSize="small" />}
          onClick={onRerun}
          sx={{ flexShrink: 0 }}
        >
          Re-run from start
        </Button>
      ) : null}
      <Button
        variant="text"
        size="small"
        aria-pressed={detailsOpen}
        startIcon={<ViewSidebarOutlinedIcon sx={{ transform: "scaleX(-1)" }} />}
        onClick={onToggleDetails}
        sx={{
          flexShrink: 0,
          color: detailsOpen ? "text.primary" : "text.secondary",
          "&:hover": { color: "text.primary" },
        }}
      >
        Details
      </Button>
      {canRerun && stepRerun ? (
        <Tooltip title="Run actions">
          <span>
            <IconButton
              size="small"
              disabled={rerunDisabled}
              aria-label="Run actions"
              aria-haspopup="menu"
              aria-expanded={rerunMenu.open ? "true" : undefined}
              onClick={rerunMenu.onOpen}
            >
              <MoreHorizIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
      ) : null}
      <Menu
        anchorEl={rerunMenu.anchorEl}
        open={rerunMenu.open}
        onClose={rerunMenu.onClose}
      >
        <MenuItem
          onClick={() => {
            rerunMenu.onClose();
            stepRerun?.();
          }}
        >
          Rerun from this step
        </MenuItem>
      </Menu>
    </>
  );

  return (
    <Box sx={{ flexShrink: 0, backgroundColor: "background.paper" }}>
      <RunHeader
        run={run}
        viewerUserId={viewerUserId}
        stepsSoFar={stepsSoFar}
        placesAtOnce={placesAtOnce}
        fallbackTitle={run ? undefined : fallbackTitle}
        actions={actions}
      />
      {step ? (
        <Stack
          direction="row"
          spacing={0.75}
          alignItems="center"
          data-testid="run-step-bar"
          sx={{
            minHeight: 44,
            px: { xs: 2, md: 3 },
            py: 0.5,
            borderBottom: 1,
            borderColor: "divider",
          }}
        >
          <StepRunStatusIcon status={step.status} />
          <Typography
            variant="subtitle1"
            component="h2"
            sx={{ fontWeight: 600, flexShrink: 1, ...truncateSx }}
          >
            {step.name}
          </Typography>
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{
              display: { xs: "none", md: "block" },
              whiteSpace: "nowrap",
              flexShrink: 0,
            }}
          >
            · {getStepRunStatusLabel(step.status)}
          </Typography>
          <StepViewToggle value={step.view} onChange={step.onViewChange} />
        </Stack>
      ) : null}
    </Box>
  );
}
