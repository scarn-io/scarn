"use client";

/**
 * The Runs tab: one row per thing an agent did (a pipeline run, or a step,
 * prompt or no-work-item Task started on its own), with a sidebar of who started
 * it and what ran, status tabs, a search box and filter chips. All of it is
 * URL state (`?status&whatRan&by&item&at&q`); the client reads the URL and
 * navigates to change it.
 */

import { Alert, Box, Button, LinearProgress } from "@mui/material";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchProjectAutomations } from "@/app/(protected)/projects/_lib/project-work-items";
import { authClient } from "@/app/_lib/auth-client";
import { CONTENT_MAX_WIDTH } from "@/components/theme-provider";
import { ColumnHeader, RunRow, type RunColumns } from "./run-row";
import { rememberRunsQuery } from "./runs-back-target";
import { RunsEmpty } from "./runs-empty";
import { RunsHeader } from "./runs-header";
import {
  parseRunsNav,
  patchRunsNav,
  runsNavHref,
  runsQueryOf,
  type RunsNav,
} from "./runs-params";
import { runsTitle, scopedSchedule, scopedWorkItem } from "./runs-scope";
import { RunsSidebar, type RunsSidebarAutomation } from "./runs-sidebar";
import { useRunsSelection } from "./runs-selection";
import { RunsToolbar } from "./runs-toolbar";
import { useProjectRuns } from "./use-project-runs";

type NavPatch = Partial<Record<keyof RunsNav, string | undefined>>;

/** The project's automations for the sidebar's hints; empty if they fail to load. */
function useSidebarAutomations(projectId: string): RunsSidebarAutomation[] {
  const [automations, setAutomations] = useState<RunsSidebarAutomation[]>([]);
  useEffect(() => {
    let cancelled = false;
    fetchProjectAutomations(projectId)
      .then((list) => {
        if (cancelled) return;
        setAutomations(
          list
            .map((automation) => ({
              id: automation.id,
              label: automation.title ?? automation.key,
              scope: automation.scope,
            }))
            .sort((left, right) => left.label.localeCompare(right.label)),
        );
      })
      .catch(() => {
        if (!cancelled) setAutomations([]);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);
  return automations;
}

export function RunsList({ projectId }: { projectId: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const searchParamsString = searchParams.toString();
  const nav = useMemo(
    () => parseRunsNav(new URLSearchParams(searchParamsString)),
    [searchParamsString],
  );
  const query = useMemo(() => runsQueryOf(nav), [nav]);
  const [composeRequested] = useState(
    () => searchParams.get("compose") === "1",
  );
  const composeCleared = useRef(false);
  useEffect(() => {
    if (!composeRequested || composeCleared.current) return;
    composeCleared.current = true;
    router.replace(runsNavHref(pathname, nav), { scroll: false });
  }, [composeRequested, router, pathname, nav]);
  useEffect(() => {
    rememberRunsQuery(projectId, searchParamsString);
  }, [projectId, searchParamsString]);
  const {
    runs,
    counts,
    hasMore,
    loading,
    loadingMore,
    error,
    loadMore,
    refresh,
  } = useProjectRuns(projectId, query);
  const selection = useRunsSelection({
    runs,
    queryKey: searchParamsString,
    onCancelled: refresh,
  });
  const automations = useSidebarAutomations(projectId);
  const viewerUserId = authClient.useSession().data?.user.id ?? null;

  const hrefFor = useCallback(
    (patch: NavPatch) => runsNavHref(pathname, patchRunsNav(nav, patch)),
    [pathname, nav],
  );
  const scopeHref = useCallback(
    (scope: { whatRan?: string; by?: string }) =>
      hrefFor({
        whatRan: scope.whatRan,
        by: scope.by,
        item: undefined,
        schedule: undefined,
        at: undefined,
      }),
    [hrefFor],
  );
  const onSearch = useCallback(
    (q: string | undefined) => {
      router.replace(hrefFor({ q }), { scroll: false });
    },
    [router, hrefFor],
  );

  const item = scopedWorkItem(nav.item, runs);
  const schedule = scopedSchedule(nav.schedule, runs);
  const title = runsTitle(
    nav,
    counts,
    item,
    (id) => automations.find((automation) => automation.id === id)?.label,
    schedule,
  );
  const columns: RunColumns = {
    whatRan: nav.whatRan === undefined,
    leading: selection.selecting,
  };

  return (
    <Box
      sx={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        maxWidth: CONTENT_MAX_WIDTH,
        mx: "auto",
        width: "100%",
      }}
    >
      <RunsSidebar
        nav={nav}
        counts={counts}
        automations={automations}
        scopeHref={scopeHref}
      />
      <Box component="section" sx={{ flex: 1, minWidth: 0, overflowY: "auto" }}>
        <Box sx={{ maxWidth: 1080, mx: "auto", px: { xs: 2, md: 4 }, py: 3 }}>
          <RunsHeader
            projectId={projectId}
            title={title}
            initialComposing={composeRequested}
          />
          <RunsToolbar
            nav={nav}
            counts={counts}
            itemKey={item?.platformKey ?? null}
            scheduleLabel={schedule?.label ?? null}
            hrefFor={hrefFor}
            onSearch={onSearch}
            actions={selection.actions}
          />
          {selection.feedback}
          {error ? (
            <Alert severity="error" sx={{ mb: 2 }}>
              {error}
            </Alert>
          ) : null}
          {loading ? (
            <LinearProgress aria-label="Loading runs" />
          ) : runs.length > 0 ? (
            <>
              <Box
                data-testid="runs-list"
                sx={{
                  border: 1,
                  borderColor: "divider",
                  borderRadius: 2,
                  overflow: "hidden",
                }}
              >
                <ColumnHeader
                  columns={columns}
                  leading={selection.headerLeading}
                />
                {runs.map((run, index) => (
                  <RunRow
                    key={`${run.type}:${run.id}`}
                    run={run}
                    columns={columns}
                    viewerUserId={viewerUserId}
                    divider={index > 0}
                    leading={
                      selection.selecting
                        ? selection.leadingFor(run)
                        : undefined
                    }
                  />
                ))}
              </Box>
              {hasMore ? (
                <Box sx={{ display: "flex", justifyContent: "center", mt: 2 }}>
                  <Button
                    variant="outlined"
                    size="small"
                    disabled={loadingMore}
                    onClick={loadMore}
                  >
                    {loadingMore ? "Loading…" : "Load more"}
                  </Button>
                </Box>
              ) : null}
            </>
          ) : error ? null : (
            <RunsEmpty nav={nav} />
          )}
        </Box>
      </Box>
    </Box>
  );
}
