"use client";

/**
 * The run page's Details drawer. Its Step tab is everything about one visit
 * of the selected node that isn't the conversation — timing, its Tasks (with
 * their liveness status), routing, input, error, result and artifacts. Logs
 * are only summarised; **Open logs** switches the page to its Logs view on
 * that run. Its Run tab (`?details=run`) is the run's overview: its input,
 * graph and lanes.
 */

import {
  Box,
  Drawer,
  IconButton,
  MenuItem,
  Select,
  Stack,
  Tab,
  Tabs,
  Typography,
} from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import { useEffect, useRef, type ReactNode } from "react";
import type {
  NodeVisitContract,
  PipelineExecutionContract,
} from "@scarn/api/frontend-contracts";
import { Elapsed } from "./elapsed";
import { RUN_DETAILS } from "./execution-detail-params";
import { ExecutionArtifactsSection } from "./execution-artifacts-section";
import { capitalize } from "./execution-status-icon";
import { formatDateTime } from "./format-datetime";
import { JsonBlock } from "./json-block";
import { RouteSection } from "./overrule-route-section";
import { insetPanelSx } from "./panel-styles";
import { getStepRunStatusLabel } from "./step-run-status-icon";
import { Meta } from "./step-run-meta";
import { runStatusWord } from "./step-thread-model";
import { LogsSummary, Muted, Section } from "./step-details-parts";
import { useSelectedTaskRun } from "./use-selected-task-run";
import { visitLabel, visitTiming } from "./visit-labels";
import { deriveVisitDisplayStatus, latestVisitTask } from "./visit-status";

const DRAWER_WIDTH = 480;

export function StepDetailsDrawer({
  execution,
  visits,
  visitId,
  onVisitChange,
  onClose,
  focusArtifacts,
  onOpenLogs,
  runNumberForTask,
  runOverview,
}: {
  execution: PipelineExecutionContract;
  /** Every visit of the selected node, oldest first; empty with no node. */
  visits: readonly NodeVisitContract[];
  /** The visit the drawer shows, or `RUN_DETAILS`; `null` closes it. */
  visitId: string | null;
  onVisitChange: (visitId: string) => void;
  onClose: () => void;
  /** Scroll to Artifacts once they render (`?focus=artifacts`). */
  focusArtifacts: boolean;
  /** Shows the Logs view on one run of the thread. */
  onOpenLogs: (runNumber: number | null) => void;
  /** The thread run number a task appears as, when the thread has it. */
  runNumberForTask: (taskId: string) => number | null;
  /** The run's overview, for the Run tab. */
  runOverview: ReactNode;
}) {
  const showRun = visitId === RUN_DETAILS || visits.length === 0;
  const newestFirst = [...visits].reverse();
  const visit =
    visits.find((candidate) => candidate.id === visitId) ??
    newestFirst.find((candidate) => candidate.status !== "superseded") ??
    newestFirst[0] ??
    null;
  const latestCurrentId = newestFirst.find(
    (candidate) => candidate.status !== "superseded",
  )?.id;

  return (
    <Drawer
      anchor="right"
      open={visitId !== null}
      onClose={onClose}
      slotProps={{
        paper: {
          "aria-label": showRun ? "Run details" : "Step details",
          sx: {
            width: { xs: "100%", md: DRAWER_WIDTH },
            backgroundColor: "background.default",
            backgroundImage: "none",
            borderLeft: 1,
            borderColor: "divider",
          },
        },
      }}
    >
      <Stack
        direction="row"
        alignItems="center"
        spacing={1}
        sx={{ px: 3, pt: 2.5, pb: 1 }}
      >
        <Typography variant="subtitle1" sx={{ fontWeight: 600, flex: 1 }}>
          Details
        </Typography>
        <IconButton size="small" onClick={onClose} aria-label="Close details">
          <CloseIcon fontSize="small" />
        </IconButton>
      </Stack>
      {visits.length > 0 ? (
        <Tabs
          value={showRun ? "run" : "step"}
          onChange={(_event, value) => {
            onVisitChange(value === "run" ? RUN_DETAILS : (visit?.id ?? ""));
          }}
          aria-label="Details for"
          sx={{ px: 3, minHeight: 36, mb: 1 }}
        >
          <Tab value="step" label="Step" sx={{ minHeight: 36, py: 0.5 }} />
          <Tab value="run" label="Run" sx={{ minHeight: 36, py: 0.5 }} />
        </Tabs>
      ) : null}
      {showRun ? (
        <Box sx={{ px: 3, py: 2, overflowY: "auto" }}>{runOverview}</Box>
      ) : visit ? (
        <>
          {visits.length > 1 ? (
            <Box sx={{ px: 3 }}>
              <Select
                size="small"
                fullWidth
                value={visit.id}
                inputProps={{ "aria-label": "Details visit" }}
                onChange={(event) => {
                  onVisitChange(event.target.value);
                }}
                sx={{ fontSize: 14 }}
              >
                {newestFirst.map((candidate) => (
                  <MenuItem key={candidate.id} value={candidate.id}>
                    {visitLabel(
                      execution,
                      candidate,
                      visits.indexOf(candidate),
                    )}
                    <Box component="span" sx={{ color: "text.secondary" }}>
                      &nbsp;·{" "}
                      {getStepRunStatusLabel(
                        deriveVisitDisplayStatus(candidate),
                      )}
                      {candidate.id === latestCurrentId ? " · latest" : ""}
                    </Box>
                  </MenuItem>
                ))}
              </Select>
            </Box>
          ) : null}
          <VisitDetails
            key={visit.id}
            visit={visit}
            focusArtifacts={focusArtifacts}
            onOpenLogs={onOpenLogs}
            runNumberForTask={runNumberForTask}
          />
        </>
      ) : (
        <Box sx={{ px: 3, py: 3 }}>
          <Muted>This node hasn&apos;t been visited yet.</Muted>
        </Box>
      )}
    </Drawer>
  );
}

/** A routing record that took no route: `taken: []` (a condition error is `taken: null`). */
function routingEndedPath(routing: NodeVisitContract["routing"]): boolean {
  const taken = routing?.["taken"];
  return Array.isArray(taken) && taken.length === 0;
}

function VisitDetails({
  visit,
  focusArtifacts,
  onOpenLogs,
  runNumberForTask,
}: {
  visit: NodeVisitContract;
  focusArtifacts: boolean;
  onOpenLogs: (runNumber: number | null) => void;
  runNumberForTask: (taskId: string) => number | null;
}) {
  const latestTask = latestVisitTask(visit);
  const status = deriveVisitDisplayStatus(visit);
  const { taskRun } = useSelectedTaskRun(
    latestTask?.taskId ?? null,
    latestTask ? `${latestTask.status}:${latestTask.completedAt ?? ""}` : null,
  );
  const timing = visitTiming(visit);
  const isRunning = status === "running";
  const isSettled = visit.status !== "active" && visit.status !== "waiting";
  const artifactTaskId = visit.resultTaskId ?? latestTask?.taskId ?? null;
  const showArtifacts = isSettled && artifactTaskId !== null;

  const artifactsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focusArtifacts || !showArtifacts) return;
    const target = artifactsRef.current;
    if (typeof target?.scrollIntoView === "function") {
      target.scrollIntoView({ block: "start" });
    }
  }, [focusArtifacts, showArtifacts]);

  return (
    <Stack spacing={4} sx={{ px: 3, py: 3, overflowY: "auto" }}>
      <Stack
        direction="row"
        spacing={3}
        useFlexGap
        flexWrap="wrap"
        sx={insetPanelSx}
      >
        <Meta label="Status" value={getStepRunStatusLabel(status)} />
        <Meta
          label="Started"
          value={formatDateTime(timing?.startedAt ?? visit.createdAt)}
        />
        <Meta
          label="Completed"
          value={formatDateTime(
            visit.completedAt ?? timing?.completedAt ?? null,
          )}
        />
        <Meta
          label={isRunning ? "Elapsed" : "Duration"}
          value={
            <Elapsed
              startedAt={timing?.startedAt ?? null}
              completedAt={timing?.completedAt ?? null}
              isRunning={isRunning}
            />
          }
        />
        {latestTask?.workBranch ? (
          <Meta
            label="Work branch"
            value={<code>{latestTask.workBranch}</code>}
          />
        ) : null}
        {visit.resolvedAt ? (
          <Meta label="Resolved" value={formatDateTime(visit.resolvedAt)} />
        ) : null}
      </Stack>

      {visit.tasks.length > 0 ? (
        <Section title="Tasks">
          <Stack spacing={0.75}>
            {visit.tasks.map((visitTask) => (
              <Stack
                key={visitTask.taskId}
                direction="row"
                spacing={1.5}
                alignItems="baseline"
              >
                <Typography variant="body2" sx={{ minWidth: 72 }}>
                  Attempt {visitTask.attemptNumber}
                </Typography>
                <Typography
                  variant="body2"
                  color={
                    visitTask.status === "abandoned" ||
                    visitTask.status === "timeout" ||
                    visitTask.status === "failed"
                      ? "error"
                      : "text.secondary"
                  }
                >
                  {capitalize(runStatusWord(visitTask.status))}
                </Typography>
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ ml: "auto", fontFamily: "var(--font-mono)" }}
                >
                  {formatDateTime(visitTask.startedAt)}
                </Typography>
              </Stack>
            ))}
          </Stack>
        </Section>
      ) : null}

      {visit.error ? (
        <Section title="Error" tone="error">
          <JsonBlock value={visit.error} />
        </Section>
      ) : null}
      {visit.nodeKind === "succeed" || visit.nodeKind === "fail" ? null : (
        <Section title={visit.nodeKind === "wait" ? "Resolution" : "Result"}>
          {isSettled ? (
            <JsonBlock value={visit.result} />
          ) : (
            <Muted>Available when the visit finishes.</Muted>
          )}
        </Section>
      )}
      <RouteSection visit={visit} />
      {visit.routing ? (
        <Section title="Routing">
          {routingEndedPath(visit.routing) ? (
            <Muted>No route matched, path ended</Muted>
          ) : null}
          <JsonBlock value={visit.routing} />
        </Section>
      ) : null}
      <Section title="Input">
        <JsonBlock value={visit.input} />
      </Section>
      {taskRun && visit.nodeKind === "step" ? (
        <Section title="Task input">
          <JsonBlock value={taskRun.inputJson} />
        </Section>
      ) : null}
      {showArtifacts ? (
        <Box ref={artifactsRef} component="section">
          <ExecutionArtifactsSection taskRunId={artifactTaskId} />
        </Box>
      ) : null}
      {latestTask ? (
        <Section title="Logs">
          <LogsSummary
            taskRunId={latestTask.taskId}
            live={!isSettled}
            onOpen={() => {
              onOpenLogs(runNumberForTask(latestTask.taskId));
            }}
          />
        </Section>
      ) : null}
    </Stack>
  );
}
