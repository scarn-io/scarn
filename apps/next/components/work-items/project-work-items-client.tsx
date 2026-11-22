"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { SearchPagination } from "@/components/common/search-pagination";
import { WorkItemFilterBar } from "@/components/work-items/filters/work-item-filter-bar";
import { WorkItemsTable } from "@/components/work-items/work-items-table";
import { useProjectMembers } from "@/components/work-items/use-project-members";
import {
  buildScoreLabel,
  parsePageParam,
  parsePageSizeParam,
  resolveWorkItemSort,
} from "@/components/work-items/project-work-items-params";
import {
  activeLabels,
  formatTimeBound,
  parseWorkItemFilters,
  withLabelAdded,
  type WorkItemFilter,
} from "@/components/work-items/filters/work-item-filter-model";
import { useCommitFilters } from "@/components/work-items/filters/use-commit-filters";
import {
  fetchProjectWorkItems,
  mergeActiveFieldFilterValues,
  type ProjectWorkItemsQuery,
  type WorkItemFieldFilterOption,
  type WorkItemListItem,
} from "@/app/(protected)/projects/_lib/project-work-items";
import {
  loadProjectWorkItemsShell,
  type ProjectShell,
} from "@/components/work-items/project-work-items-shell";
import { RecordListEmpty } from "@/components/common/record-list/record-list-empty";
import { CopyableCommand } from "@/components/common/copyable-command";
import {
  useIsProjectMember,
  useProjectPath,
} from "@/components/project-route-context";
import AddIcon from "@mui/icons-material/Add";
import {
  CircularProgress,
  Box,
  Button,
  LinearProgress,
  Link as MuiLink,
  Paper,
  Stack,
  Typography,
} from "@mui/material";
import Link from "next/link";

// ─── Types ────────────────────────────────────────────────────────────────────

type Pagination = { page: number; pageSize: number; total: number };

/** One page of work items, refetched whenever the query params change. */
type WorkItemsPage = { items: WorkItemListItem[]; pagination: Pagination };

type PageState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      projectName: string;
      hasEnabledProjectAutomation: boolean;
      items: WorkItemListItem[];
      pagination: Pagination;
    };

// ─── Component ────────────────────────────────────────────────────────────────

export function ProjectWorkItemsClient({ projectId }: { projectId: string }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const projectPath = useProjectPath();
  const isMember = useIsProjectMember();
  const { members } = useProjectMembers(projectId, isMember);

  // ── Query params ────────────────────────────────────────────────────────────
  // Normalized here rather than passed through raw: the server echoes back the
  // page it actually served, so the component has to agree with it.
  const page = parsePageParam(searchParams.get("page"));
  const pageSize = parsePageSizeParam(searchParams.get("pageSize"));

  // Serialized once so parsing is memoized on the actual URL contents.
  const searchParamsString = searchParams.toString();

  const filters = useMemo(
    () => parseWorkItemFilters(new URLSearchParams(searchParamsString)),
    [searchParamsString],
  );

  const sort = useMemo(
    () => resolveWorkItemSort(new URLSearchParams(searchParamsString)),
    [searchParamsString],
  );

  const search = useMemo(
    () => filters.find((filter) => filter.kind === "text")?.value ?? "",
    [filters],
  );

  const fieldFilters = useMemo(
    () => filters.filter((filter) => filter.kind === "field"),
    [filters],
  );

  const updated = useMemo(
    () => filters.find((filter) => filter.kind === "updated"),
    [filters],
  );

  const awaitingApproval = useMemo(
    () => filters.some((filter) => filter.kind === "awaitingApproval"),
    [filters],
  );

  const assignee = filters.find((filter) => filter.kind === "assignee")?.value;
  const agent = filters.find((filter) => filter.kind === "agent")?.value;
  const status = filters.find((filter) => filter.kind === "status")?.value;
  const platform = filters.find((filter) => filter.kind === "platform")?.value;

  // The URL's own `sort` token is forwarded verbatim — it's already the exact
  // string the route parses, so there's nothing to reassemble here.
  const sortToken = searchParams.get("sort") ?? undefined;

  const query = useMemo<ProjectWorkItemsQuery>(
    () => ({
      q: search.length > 0 ? search : undefined,
      page,
      pageSize,
      sort: sortToken,
      fieldFilters,
      labels: activeLabels(filters),
      updatedAfter: updated?.after ? formatTimeBound(updated.after) : undefined,
      updatedBefore: updated?.before
        ? formatTimeBound(updated.before)
        : undefined,
      awaitingApproval,
      assignee,
      agent,
      status,
      platform,
    }),
    [
      search,
      page,
      pageSize,
      sortToken,
      fieldFilters,
      filters,
      updated,
      awaitingApproval,
      assignee,
      agent,
      status,
      platform,
    ],
  );

  // ── Data state ──────────────────────────────────────────────────────────────
  const [shell, setShell] = useState<ProjectShell | undefined>(undefined);
  const [shellError, setShellError] = useState<string | undefined>(undefined);
  const [fieldOptions, setFieldOptions] = useState<WorkItemFieldFilterOption[]>(
    [],
  );
  const [workItemsPage, setWorkItemsPage] = useState<WorkItemsPage | undefined>(
    undefined,
  );
  const [pageError, setPageError] = useState<string | undefined>(undefined);
  // True while a work items request is in flight. Only surfaced once a page has
  // already been rendered — the first load gets the full-page spinner instead.
  const [pending, setPending] = useState(false);

  // Project, pipeline definitions, and field options are all query-independent,
  // so they load once per project. Field options are best-effort: losing them
  // costs the filter dropdowns, which shouldn't blank the whole page.
  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const loaded = await loadProjectWorkItemsShell(projectId);
        if (cancelled) return;
        setShell(loaded.shell);
        setFieldOptions(loaded.fieldOptions);
      } catch (err) {
        if (cancelled) return;
        setShellError(
          err instanceof Error ? err.message : "Failed to load project",
        );
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // One page of work items per distinct query. React runs the previous cleanup
  // before this effect re-runs, so an in-flight response from a superseded query
  // is discarded by its own `cancelled` flag — no sequence numbers needed.
  useEffect(() => {
    let cancelled = false;
    setPending(true);

    const load = async () => {
      try {
        const result = await fetchProjectWorkItems(projectId, query);
        if (cancelled) return;
        setWorkItemsPage({
          items: result.items,
          pagination: result.pagination,
        });
        setPageError(undefined);
      } catch (err) {
        if (cancelled) return;
        setPageError(
          err instanceof Error ? err.message : "Failed to load work items",
        );
      } finally {
        // A superseded effect leaves `pending` alone: its replacement has
        // already set it, and will clear it when its own request settles.
        if (!cancelled) setPending(false);
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [projectId, query]);

  // ── Derived display data ────────────────────────────────────────────────────

  const pageState = useMemo<PageState>(() => {
    const message = shellError ?? pageError;
    if (message !== undefined) return { status: "error", message };
    if (shell === undefined || workItemsPage === undefined) {
      return { status: "loading" };
    }
    return {
      status: "ready",
      projectName: shell.projectName,
      hasEnabledProjectAutomation: shell.hasEnabledProjectAutomation,
      items: workItemsPage.items,
      pagination: workItemsPage.pagination,
    };
  }, [shellError, pageError, shell, workItemsPage]);

  const scoreCatalog = useMemo(() => shell?.scoreCatalog ?? [], [shell]);

  const items = useMemo(() => workItemsPage?.items ?? [], [workItemsPage]);

  // `WorkItemsTable` shows the score column iff `scores` is defined, so this is
  // `undefined` when no score sort is active. It must not depend on the map
  // being non-empty: a sorted page can legitimately contain only unscored
  // items (`NULLS LAST` puts them on the last page), and the column has to
  // stay.
  const scores = useMemo(() => {
    if (sort.kind !== "score") return undefined;
    const map = new Map<string, number>();
    for (const item of items) {
      if (typeof item.signalScore === "number") {
        map.set(item.id, item.signalScore);
      }
    }
    return map;
  }, [items, sort]);

  // Union the active filters' values back into the fetched options so a value
  // that was capped out (or is mid-flight) still displays in its dropdown.
  const fieldFilterOptions = useMemo(
    () => mergeActiveFieldFilterValues(fieldOptions, fieldFilters),
    [fieldOptions, fieldFilters],
  );

  const scoreLabel = useMemo(
    () =>
      sort.kind === "score"
        ? buildScoreLabel(
            scoreCatalog,
            sort.pipelineDefinitionId,
            sort.stepKey,
            sort.signalKey,
          )
        : undefined,
    [scoreCatalog, sort],
  );

  // The table's empty state offers one clause to drop, so removal has to be
  // reachable from there as well as from the bar's chips.
  const commitFilters = useCommitFilters();
  const removeFilter = useCallback(
    (target: WorkItemFilter) => {
      commitFilters(filters.filter((filter) => filter !== target));
    },
    [commitFilters, filters],
  );

  const buildHref = useCallback(
    (nextPage: number) => {
      const nextParams = new URLSearchParams(searchParams.toString());
      nextParams.set("page", String(nextPage));
      return `${pathname}?${nextParams.toString()}`;
    },
    [pathname, searchParams],
  );

  // ── Render ──────────────────────────────────────────────────────────────────

  if (pageState.status === "loading") {
    return (
      <Box sx={{ display: "flex", alignItems: "center", gap: 2, mt: 4 }}>
        <CircularProgress size={24} />
        <Typography color="text.secondary">Loading work items…</Typography>
      </Box>
    );
  }

  if (pageState.status === "error") {
    return (
      <Typography color="error" sx={{ mt: 4 }}>
        {pageState.message}
      </Typography>
    );
  }

  // Distinguish a brand-new project from a filtered-to-empty result. With no
  // filter clauses at all, an empty result means there is genuinely nothing
  // here yet — that's where a new user needs a nudge, not a "no matches"
  // message. Asking the filter model rather than enumerating clause kinds is
  // what keeps this correct as kinds are added: a fresh project narrowed to
  // "updated in the last 7 days" must not claim it has no work items.
  // Sort is excluded on purpose: it never reduces the result set.
  const isBrandNewProject =
    filters.length === 0 && pageState.pagination.total === 0;

  if (isBrandNewProject) {
    return (
      <>
        <PageHeader
          eyebrow={pageState.projectName}
          title="Work items"
          description="Work items are the units of work your pipelines run on."
        />
        <Paper variant="outlined">
          <RecordListEmpty
            title="No work items yet"
            description={
              <>
                Create one by hand to try a pipeline now, or connect GitHub or
                Jira in{" "}
                <MuiLink component={Link} href={projectPath("settings")}>
                  project settings
                </MuiLink>{" "}
                to ingest issues automatically.
              </>
            }
            action={
              isMember ? (
                <Stack spacing={2} alignItems="center">
                  <Button
                    variant="contained"
                    startIcon={<AddIcon />}
                    href={projectPath("work-items", "new")}
                  >
                    Create work item
                  </Button>
                  {pageState.hasEnabledProjectAutomation ? null : (
                    <Stack spacing={0.75} alignItems="center">
                      <Typography variant="body2" color="text.secondary">
                        Then design a pipeline:
                      </Typography>
                      <CopyableCommand command="scarn pipelines design" />
                    </Stack>
                  )}
                </Stack>
              ) : undefined
            }
          />
        </Paper>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Work items"
        description="Everything queued for the agent in this project — synced from connected trackers or created here."
        actions={
          isMember ? (
            <Button
              component={Link}
              href={projectPath("work-items", "new")}
              variant="contained"
              color="primary"
              startIcon={<AddIcon />}
            >
              New work item
            </Button>
          ) : undefined
        }
      />
      {/* The filter bar stays mounted across refetches: it holds the search text
          in local state, so remounting it would clear the box and drop focus. */}
      <WorkItemFilterBar
        filters={filters}
        total={pageState.pagination.total}
        scoreCatalog={scoreCatalog}
        sort={sort}
        scoreLabel={scoreLabel}
        fieldFilterOptions={fieldFilterOptions}
        labelOptions={shell?.labelOptions ?? []}
        members={members}
      />
      {/* Fixed-height slot so toggling the indicator doesn't shift the table. */}
      <Box sx={{ height: 4, mb: 1 }}>
        {pending && <LinearProgress aria-label="Loading work items" />}
      </Box>
      <Box
        sx={{
          opacity: pending ? 0.5 : 1,
          transition: "opacity 120ms ease-in-out",
        }}
      >
        <WorkItemsTable
          workItems={pageState.items}
          workItemHrefPrefix={projectPath("work-items")}
          sort={sort}
          scores={scores}
          scoreLabel={scoreLabel}
          filters={filters}
          onRemoveFilter={removeFilter}
          onLabelClick={(label) => {
            commitFilters(withLabelAdded(filters, label));
          }}
        />
      </Box>
      <SearchPagination
        page={pageState.pagination.page}
        pageSize={pageState.pagination.pageSize}
        total={pageState.pagination.total}
        buildHref={buildHref}
      />
    </>
  );
}
