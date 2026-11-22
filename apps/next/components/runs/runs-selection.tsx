"use client";

/**
 * Batch cancel on the Runs list: a **Select** toggle for members who may
 * write executions, a checkbox on each run that can still be stopped, and
 * the confirmation that cancels them.
 */

import { Alert, Box, Button, Checkbox } from "@mui/material";
import { useMemo, useState, type ReactNode } from "react";
import { isProjectRunInProgress } from "@scarn/core/pipeline-executions/project-runs/contracts/project-runs-contracts";
import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import {
  useHasProjectPermission,
  useIsProjectMember,
} from "@/components/project-route-context";
import {
  CancelRunsDialog,
  cancelRunsSummary,
  type CancellableRun,
} from "./cancel-runs-dialog";
import type { ProjectRun } from "./runs-api";

const runKey = (run: Pick<ProjectRun, "type" | "id">) =>
  `${run.type}:${run.id}`;

export const isRunCancellable = (
  run: ProjectRun,
): run is ProjectRun & CancellableRun => isProjectRunInProgress(run.status);

const SLOT_WIDTH = 24;

function Slot({ children }: { children?: ReactNode }) {
  return (
    <Box sx={{ width: SLOT_WIDTH, display: "flex", justifyContent: "center" }}>
      {children}
    </Box>
  );
}

export type RunsSelection = {
  /** Whether rows show their checkboxes. */
  selecting: boolean;
  /** Select / Cancel N / Done, for the toolbar; `null` when not allowed. */
  actions: ReactNode;
  /** The column header's select-all box. */
  headerLeading: ReactNode;
  /** A row's checkbox, or an empty slot for a run that can't be cancelled. */
  leadingFor: (run: ProjectRun) => ReactNode;
  /** The result of the last batch cancel, and the confirmation dialog. */
  feedback: ReactNode;
};

/**
 * Selection state for batch cancel. It clears whenever `queryKey` changes,
 * and `onCancelled` runs after a batch cancel so the list can re-read.
 */
export function useRunsSelection({
  runs,
  queryKey,
  onCancelled,
}: {
  runs: readonly ProjectRun[];
  queryKey: string;
  onCancelled: () => void;
}): RunsSelection {
  const isMember = useIsProjectMember();
  const canWriteExecutions = useHasProjectPermission("executions:write");
  const allowed = isMember && canWriteExecutions;
  const apiClient = useMemo(() => getBrowserScarnApiClient(), []);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [seenQueryKey, setSeenQueryKey] = useState(queryKey);

  if (queryKey !== seenQueryKey) {
    setSeenQueryKey(queryKey);
    setSelected(new Set());
    setResult(null);
  }

  const cancellable = runs.filter(isRunCancellable);
  const chosen = cancellable.filter((run) => selected.has(runKey(run)));
  const allChosen =
    cancellable.length > 0 && chosen.length === cancellable.length;

  const toggle = (run: ProjectRun) => {
    setSelected((previous) => {
      const next = new Set(previous);
      const key = runKey(run);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const stopSelecting = () => {
    setSelecting(false);
    setSelected(new Set());
  };

  const active = allowed && selecting;

  const actions = !allowed ? null : selecting ? (
    <>
      <Button
        variant="outlined"
        color="warning"
        size="small"
        disabled={chosen.length === 0}
        onClick={() => {
          setConfirming(true);
        }}
      >
        {`Cancel ${String(chosen.length)} run${chosen.length === 1 ? "" : "s"}`}
      </Button>
      <Button size="small" color="inherit" onClick={stopSelecting}>
        Done
      </Button>
    </>
  ) : (
    <Button
      size="small"
      color="inherit"
      onClick={() => {
        setSelecting(true);
        setResult(null);
      }}
    >
      Select
    </Button>
  );

  const headerLeading = active ? (
    <Slot>
      <Checkbox
        size="small"
        sx={{ p: 0 }}
        disabled={cancellable.length === 0}
        checked={allChosen}
        indeterminate={chosen.length > 0 && !allChosen}
        slotProps={{
          input: { "aria-label": "Select all cancellable runs" },
        }}
        onChange={() => {
          setSelected(allChosen ? new Set() : new Set(cancellable.map(runKey)));
        }}
      />
    </Slot>
  ) : null;

  const leadingFor = (run: ProjectRun) =>
    isRunCancellable(run) ? (
      <Slot>
        <Checkbox
          size="small"
          sx={{ p: 0 }}
          checked={selected.has(runKey(run))}
          slotProps={{ input: { "aria-label": `Select ${run.title}` } }}
          onClick={(event) => {
            event.stopPropagation();
          }}
          onChange={() => {
            toggle(run);
          }}
        />
      </Slot>
    ) : (
      <Slot />
    );

  const feedback = (
    <>
      {result ? (
        <Alert
          severity="info"
          sx={{ mb: 2 }}
          onClose={() => {
            setResult(null);
          }}
        >
          {result}
        </Alert>
      ) : null}
      {allowed ? (
        <CancelRunsDialog
          open={confirming}
          runs={chosen}
          apiClient={apiClient}
          onClose={() => {
            setConfirming(false);
          }}
          onCancelled={(outcome) => {
            setConfirming(false);
            stopSelecting();
            setResult(cancelRunsSummary(outcome));
            onCancelled();
          }}
        />
      ) : null}
    </>
  );

  return { selecting: active, actions, headerLeading, leadingFor, feedback };
}
