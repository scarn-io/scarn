"use client";

import { Alert, Box, CircularProgress, Typography } from "@mui/material";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { authClient } from "@/app/_lib/auth-client";
import {
  useHasProjectPermission,
  useIsProjectMember,
} from "@/components/project-route-context";
import { useProjectRun } from "@/components/runs/use-project-run";
import { CONTENT_MAX_WIDTH } from "../theme-provider";
import { ExecutionDetailHeader } from "./execution-detail-header";
import { buildHeaderStep } from "./execution-header-step";
import { ExecutionMainBanner } from "./execution-main-banner";
import { useExecutionDetail } from "./use-execution-detail";
import { useWaitControls } from "./use-wait-controls";
import type { NodeVisitContract } from "@scarn/api/frontend-contracts";
import {
  RUN_DETAILS,
  buildRailHref,
  buildSelectionHref,
  buildStepPageHref,
  parseDetailsParam,
  parseExecutionDetailSelection,
  parseFocusParam,
  parseLogFilter,
  parseRailParam,
  parseRunParam,
  parseStepView,
  pinSelection,
  type StepNavSelection,
  type StepPagePatch,
} from "./execution-detail-params";
import { canRerunVisit, startVisit } from "./execution-step-action-guards";
import { ExecutionOverview } from "./execution-overview";
import {
  buildExecutionStepItems,
  selectionForVisit,
} from "./execution-step-items";
import { ExecutionStepPane, resolveSelectedStep } from "./execution-step-pane";
import { landingVisit, placesAtOnce, stepsSoFar } from "./landing-visit";
import { OverruleProvider } from "./overrule-route-section";
import { useOverruleControls } from "./use-overrule-controls";
import { RunRail } from "./run-rail";
import { StepDetailsDrawer } from "./step-details-drawer";
import { TaskRunLogsCacheProvider } from "./use-task-run-logs";
import { VisitTimeline } from "./visit-timeline";
import { buildVisitTimeline } from "./visit-timeline-entries";

/**
 * A pipeline run's page: the shared run header, the step rail, and the
 * selected visit's pane. With no `?step=` it lands on `landingVisit`; the
 * run's overview (input, graph, lanes) is the Details drawer's Run tab.
 */
export function ExecutionDetailView({
  projectId,
  executionId,
  runPollIntervalMs,
}: {
  projectId: string;
  executionId: string;
  /** Overrides the run row's poll interval (tests). */
  runPollIntervalMs?: number;
}) {
  const runRow = useProjectRun(
    projectId,
    { type: "pipeline", id: executionId },
    runPollIntervalMs,
  );
  const viewerUserId = authClient.useSession().data?.user.id ?? null;
  const isMember = useIsProjectMember();
  const canWriteExecutions = useHasProjectPermission("executions:write");
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const {
    execution,
    definition,
    version,
    workItem,
    loading,
    error,
    actionError,
    pendingActionLabel,
    isMutating,
    rerunVisit,
    postVisitRoute,
    sendVisitMessage,
    reload,
    ...mutations
  } = useExecutionDetail(projectId, executionId);
  const overrule = useOverruleControls({
    execution,
    version,
    viewerUserId,
    canWrite: canWriteExecutions,
    postVisitRoute,
    onApplied: reload,
  });
  const { controls: waitControls, toast } = useWaitControls({
    run: runRow.run,
    definition: version?.definition ?? null,
    pending: isMutating,
    mutations,
  });

  const refreshRunRow = runRow.refresh;
  const runVersion = execution
    ? `${execution.status}:${execution.updatedAt}:${String(execution.visits.length)}`
    : null;
  const seenRunVersion = useRef<string | null>(null);
  useEffect(() => {
    if (runVersion === null) return;
    const previous = seenRunVersion.current;
    seenRunVersion.current = runVersion;
    if (previous !== null && previous !== runVersion) refreshRunRow();
  }, [runVersion, refreshRunRow]);

  // The selection, step page view and rail mode live in the URL
  // (`execution-detail-params.ts`), so the view is a shareable link.
  const urlSelection = parseExecutionDetailSelection(searchParams);
  const stepView = parseStepView(searchParams);
  const logFilter = parseLogFilter(searchParams);
  const logsRunNumber = parseRunParam(searchParams);
  const focusArtifacts = parseFocusParam(searchParams) === "artifacts";
  const detailsParam = parseDetailsParam(searchParams);
  const railMode = parseRailParam(searchParams);

  // Below `md` the rail is a collapsible panel atop main, toggled by CSS
  // breakpoints so first paint matches the server render.
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  // Full-screen Logs is a passing display choice, not part of the URL.
  const [logsFullScreen, setLogsFullScreen] = useState(false);
  const mainScrollRef = useRef<HTMLDivElement>(null);

  const stepItems = useMemo(
    () => (execution ? buildExecutionStepItems({ execution, version }) : []),
    [execution, version],
  );
  const landing = execution ? landingVisit(execution) : null;
  const selection: StepNavSelection =
    urlSelection.kind === "overview" && landing
      ? selectionForVisit(stepItems, landing)
      : urlSelection;
  const selected = resolveSelectedStep(stepItems, selection);
  const timeline = useMemo(
    () =>
      execution ? buildVisitTimeline(execution, stepItems, viewerUserId) : [],
    [execution, stepItems, viewerUserId],
  );

  if (loading) {
    return (
      <Box sx={{ flex: 1, display: "grid", placeItems: "center" }}>
        <CircularProgress />
      </Box>
    );
  }

  if (error || !execution) {
    return (
      <Box
        sx={{ p: 4, maxWidth: CONTENT_MAX_WIDTH, mx: "auto", width: "100%" }}
      >
        <Alert severity="error">
          {error || "Pipeline execution could not be loaded."}
        </Alert>
      </Box>
    );
  }

  const handleStepPageNavigate = (patch: StepPagePatch) => {
    router.replace(
      buildStepPageHref(pathname, pinSelection(searchParams, selection), patch),
      { scroll: false },
    );
  };

  const handleSelect = (next: StepNavSelection) => {
    setMobileNavOpen(false);
    if (next.kind === "overview") {
      handleStepPageNavigate({ details: RUN_DETAILS });
      return;
    }
    router.replace(buildSelectionHref(pathname, searchParams, next), {
      scroll: false,
    });
  };

  const handleSelectVisit = (visit: NodeVisitContract) => {
    handleSelect(selectionForVisit(stepItems, visit));
  };

  const canRerun = (visit: NodeVisitContract) =>
    canWriteExecutions && canRerunVisit(execution, visit);

  const { step: selectedStep, visit: selectedVisit } = selected;
  const selectedVisitId = selectedVisit?.id ?? null;
  const stepsNav = (
    <VisitTimeline
      entries={timeline}
      selectedVisitId={selectedVisitId}
      onSelect={(entry) => {
        handleSelectVisit(entry.visit);
      }}
    />
  );
  const selectionLabel =
    selection.kind === "overview"
      ? "Pipeline run"
      : (selectedStep?.title ?? selection.nodeId);
  const runOverview = (
    <ExecutionOverview
      execution={execution}
      version={version}
      versionFailed={version === null}
      steps={stepItems}
      onSelect={handleSelect}
    />
  );

  const mainBanner = (
    <ExecutionMainBanner
      mobileNavOpen={mobileNavOpen}
      onToggleMobileNav={() => {
        setMobileNavOpen((open) => !open);
      }}
      selectionLabel={selectionLabel}
      stepsNav={stepsNav}
      error={actionError}
      failedOverrule={overrule.failedOverrule}
    />
  );

  const fullScreen =
    logsFullScreen && selectedStep !== null && stepView === "logs";
  if (logsFullScreen && !fullScreen) setLogsFullScreen(false);

  const detailsVisitId =
    detailsParam ?? (focusArtifacts ? (selectedVisit?.id ?? null) : null);
  const detailsOpen = detailsVisitId !== null;
  const headerStep = selectedStep
    ? buildHeaderStep({
        step: selectedStep,
        status: selected.status,
        view: stepView,
        onNavigate: handleStepPageNavigate,
        onFullScreenChange: setLogsFullScreen,
        onRerun:
          selectedVisit && canRerun(selectedVisit)
            ? () => {
                rerunVisit(selectedVisit.id);
              }
            : null,
      })
    : null;
  const firstVisit = startVisit(execution);

  return (
    <TaskRunLogsCacheProvider>
      <OverruleProvider value={overrule.context}>
        <Box
          sx={{
            flex: 1,
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
            backgroundColor: "background.default",
          }}
        >
          {fullScreen ? null : (
            <ExecutionDetailHeader
              run={runRow.notFound ? null : runRow.run}
              viewerUserId={viewerUserId}
              stepsSoFar={stepsSoFar(execution)}
              placesAtOnce={placesAtOnce(execution)}
              fallbackTitle={
                workItem?.title ?? definition?.name ?? "Pipeline run"
              }
              detailsOpen={detailsOpen}
              onToggleDetails={() => {
                handleStepPageNavigate({
                  details: detailsOpen
                    ? null
                    : (selectedVisit?.id ?? RUN_DETAILS),
                });
              }}
              onRerun={
                firstVisit && canRerunVisit(execution, firstVisit)
                  ? () => {
                      rerunVisit(firstVisit.id);
                    }
                  : null
              }
              rerunDisabled={isMutating}
              canRerun={isMember && canWriteExecutions}
              pendingActionLabel={pendingActionLabel}
              step={headerStep}
            />
          )}

          <Box
            sx={{
              width: "100%",
              flex: 1,
              minHeight: 0,
              minWidth: 0,
              display: "flex",
            }}
          >
            {fullScreen ? null : (
              <RunRail
                mode={railMode}
                onModeChange={(mode) => {
                  router.replace(buildRailHref(pathname, searchParams, mode), {
                    scroll: false,
                  });
                }}
                entries={timeline}
                selectedVisitId={selectedVisitId}
                onSelectVisit={handleSelectVisit}
                version={version}
                versionFailed={version === null}
                visits={execution.visits}
              />
            )}

            {selection.kind === "overview" || !selectedStep ? (
              <Box
                ref={mainScrollRef}
                component="section"
                sx={{
                  flex: 1,
                  minWidth: 0,
                  minHeight: 0,
                  overflowY: "auto",
                  px: { xs: 1.5, md: 3 },
                  py: { xs: 2, md: 3 },
                }}
              >
                {mainBanner}
                {selection.kind === "step" ? (
                  <Typography
                    variant="body2"
                    color="text.secondary"
                    sx={{ mt: 2 }}
                  >
                    No node <code>{selection.nodeId}</code> exists in this run.
                  </Typography>
                ) : null}
                <Box sx={{ mt: selection.kind === "step" ? 3 : 0 }}>
                  {runOverview}
                </Box>
                <StepDetailsDrawer
                  execution={execution}
                  visits={[]}
                  visitId={detailsVisitId}
                  onVisitChange={() => {}}
                  onClose={() => {
                    handleStepPageNavigate({ details: null });
                  }}
                  focusArtifacts={false}
                  onOpenLogs={() => {}}
                  runNumberForTask={() => null}
                  runOverview={runOverview}
                />
              </Box>
            ) : (
              <Box
                component="section"
                sx={{
                  flex: 1,
                  minWidth: 0,
                  minHeight: 0,
                  display: "flex",
                  flexDirection: "column",
                }}
              >
                <ExecutionStepPane
                  execution={execution}
                  executionId={executionId}
                  step={selectedStep}
                  visit={selectedVisit}
                  stepItems={stepItems}
                  banner={fullScreen ? null : mainBanner}
                  view={stepView}
                  logFilter={logFilter}
                  logsRunNumber={logsRunNumber}
                  detailsVisitId={detailsVisitId}
                  onNavigate={handleStepPageNavigate}
                  focusArtifacts={focusArtifacts}
                  fullScreen={fullScreen}
                  onFullScreenChange={setLogsFullScreen}
                  waitControls={waitControls}
                  isMutating={isMutating}
                  pathname={pathname}
                  searchParams={searchParams}
                  sendVisitMessage={sendVisitMessage}
                  onConversationChanged={reload}
                  runOverview={runOverview}
                />
              </Box>
            )}
          </Box>
        </Box>
        {overrule.dialog}
      </OverruleProvider>
      {toast}
    </TaskRunLogsCacheProvider>
  );
}
