// Server-only helpers — imports next/headers via getScarnApiClient.
// Do NOT import this file from "use client" components.
import { getScarnApiClient } from "@/app/_lib/scarn-api-client";
import { parseUuidV7 } from "@scarn/api/frontend-contracts";
import type {
  PipelineExecutionContract,
  PipelineExecutionSummaryContract,
  WorkItemListItemContract,
} from "@scarn/api/frontend-contracts";

/**
 * Data loading for the project Overview page
 * (`docs/demo-showcase-implementation-plan.md` Phase 5a).
 *
 * Two independent loads, one per audience, so neither viewer pays for the
 * other's requests: {@link loadProjectOverviewCounts} for members and
 * {@link loadProjectOverviewTour} for non-members.
 *
 * Everything here is deliberately *generic*. This page renders for every
 * project, not just the seeded demo, so a "flagship item" is never assumed and
 * no fixture-specific work-item key, pipeline key, or step key is ever
 * hardcoded — a target that cannot be resolved from the project's own data
 * comes back `null` and its card is dropped, rather than rendering a link that
 * 404s. Both loaders swallow request failures for the same reason: this page is
 * the landing site's highest-intent CTA target, and a degraded Overview beats a
 * 500.
 */

/** How many work items the tour scans for a featured run. One page. */
const WORK_ITEM_SCAN_PAGE_SIZE = 25;
/**
 * How many of a run's steps get an artifact probe. Artifacts are only listable
 * per task (`GET /task-runs/:taskRunId/artifacts`) — there is no
 * by-execution endpoint — so finding which step recorded a Playwright trace
 * costs one request per step. The probes run in parallel and this cap bounds
 * them; a pipeline longer than this simply loses the trace card.
 */
const TRACE_PROBE_STEP_LIMIT = 4;

export type ProjectOverviewCounts = {
  workItems: number;
  executions: number;
  runningExecutions: number;
  succeededExecutions: number;
  pipelines: number;
  integrations: ProjectOverviewIntegration[];
  hasEnabledProjectAutomation: boolean;
};

/** The slice of a project integration the setup checklist reads. */
export type ProjectOverviewIntegration = {
  platform: string;
  status: string;
};

/** The project fields the counts loader needs. */
export type ProjectOverviewCountsProject = {
  id: string;
};

/** A run the Overview page can point a visitor at. */
export type OverviewRunHighlight = {
  executionId: string;
  workItemId: string;
  workItemTitle: string;
  /**
   * The node to land on, or `null` to land on the run's overview instead.
   * Only ever a node the run actually visited, so the deep link resolves.
   */
  nodeId: string | null;
};

/**
 * The guest tour's three targets, any of which may be `null` — an empty
 * project, a project whose runs have never succeeded, and a project with
 * nothing in flight each legitimately produce fewer than three cards.
 *
 * `trace` is the same run and step as `transcript` whenever that step recorded
 * a `playwright-trace` artifact: the two cards frame one piece of content two
 * ways (read what the agent said vs. watch what it did in the browser).
 */
export type ProjectOverviewTour = {
  transcript: OverviewRunHighlight | null;
  trace: OverviewRunHighlight | null;
  inProgress: OverviewRunHighlight | null;
};

const EMPTY_TOUR: ProjectOverviewTour = {
  transcript: null,
  trace: null,
  inProgress: null,
};

type ApiClient = Awaited<ReturnType<typeof getScarnApiClient>>;
type RequestHeaders = Record<string, string>;

/**
 * Member-facing counts, shared by the Overview member summary and the project
 * setup checklist. Mostly `total`-only reads (page size 1 where the endpoint
 * is paginated) plus the integration and automation lists — deliberately
 * unelaborate, per the plan: the member summary is not what this page is for.
 */
export async function loadProjectOverviewCounts(
  project: ProjectOverviewCountsProject,
  requestHeaders: RequestHeaders,
): Promise<ProjectOverviewCounts> {
  try {
    const apiClient = await getScarnApiClient();
    const parsedProjectId = parseUuidV7(project.id);

    const [
      workItems,
      executions,
      running,
      succeeded,
      pipelines,
      integrations,
      automations,
    ] = await Promise.all([
      apiClient.api.projects({ projectId: parsedProjectId })["work-items"].get({
        query: { page: 1, pageSize: 1 },
        headers: requestHeaders,
      }),
      apiClient.api["pipeline-executions"].get({
        query: { projectId: parsedProjectId, page: 1, pageSize: 1 },
        headers: requestHeaders,
      }),
      apiClient.api["pipeline-executions"].get({
        query: {
          projectId: parsedProjectId,
          status: "running",
          page: 1,
          pageSize: 1,
        },
        headers: requestHeaders,
      }),
      apiClient.api["pipeline-executions"].get({
        query: {
          projectId: parsedProjectId,
          status: "succeeded",
          page: 1,
          pageSize: 1,
        },
        headers: requestHeaders,
      }),
      apiClient.api
        .projects({ projectId: parsedProjectId })
        ["pipeline-definitions"].get({ headers: requestHeaders }),
      apiClient.api
        .projects({ projectId: parsedProjectId })
        .integrations.get({ headers: requestHeaders }),
      apiClient.api
        .projects({ projectId: parsedProjectId })
        .automations.get({ headers: requestHeaders }),
    ]);

    return {
      workItems: workItems.data?.pagination.total ?? 0,
      executions: executions.data?.pagination.total ?? 0,
      runningExecutions: running.data?.pagination.total ?? 0,
      succeededExecutions: succeeded.data?.pagination.total ?? 0,
      pipelines: pipelines.data?.length ?? 0,
      integrations: (integrations.data ?? []).map((integration) => ({
        platform: integration.platform,
        status: integration.status,
      })),
      hasEnabledProjectAutomation: (automations.data ?? []).some(
        (automation) => automation.scope === "project" && automation.enabled,
      ),
    };
  } catch {
    return {
      workItems: 0,
      executions: 0,
      runningExecutions: 0,
      succeededExecutions: 0,
      pipelines: 0,
      integrations: [],
      hasEnabledProjectAutomation: false,
    };
  }
}

/** The work item's most recent run in `status`, or null when it has none. */
async function findLatestExecution(
  apiClient: ApiClient,
  requestHeaders: RequestHeaders,
  projectId: string,
  workItem: WorkItemListItemContract,
  status: "succeeded" | "running",
): Promise<PipelineExecutionSummaryContract | null> {
  const { data } = await apiClient.api["pipeline-executions"].get({
    query: {
      projectId: parseUuidV7(projectId),
      workItemId: parseUuidV7(workItem.id),
      status,
      sort: "newest",
      page: 1,
      pageSize: 1,
    },
    headers: requestHeaders,
  });

  return data?.items[0] ?? null;
}

/**
 * Resolves which of a run's step nodes to deep-link into, and whether that
 * visit recorded a Playwright trace.
 *
 * Prefers the earliest current step visit carrying a `playwright-trace`
 * artifact: a step that drove a real browser has both the richest transcript
 * and the trace worth showing, and it is the honest target for both cards.
 * Falls back to the run's last succeeded step visit, which is where a reader
 * would look for the outcome.
 */
async function resolveRunStep(
  apiClient: ApiClient,
  requestHeaders: RequestHeaders,
  execution: PipelineExecutionContract,
): Promise<{ nodeId: string | null; hasTrace: boolean }> {
  const stepVisits = execution.visits
    .filter(
      (visit) => visit.nodeKind === "step" && visit.status !== "superseded",
    )
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));

  if (stepVisits.length === 0) {
    return { nodeId: null, hasTrace: false };
  }

  const probed = await Promise.all(
    stepVisits.slice(0, TRACE_PROBE_STEP_LIMIT).map(async (visit) => {
      const taskId = visit.resultTaskId ?? visit.tasks.at(-1)?.taskId ?? null;
      if (taskId === null) return { nodeId: visit.nodeId, hasTrace: false };
      const { data } = await apiClient.api["task-runs"]({
        taskRunId: parseUuidV7(taskId),
      }).artifacts.get({ headers: requestHeaders });

      return {
        nodeId: visit.nodeId,
        hasTrace: (data ?? []).some(
          (artifact) => artifact.kind === "playwright-trace",
        ),
      };
    }),
  );

  const traced = probed.find((step) => step.hasTrace);
  if (traced) return traced;

  const lastSucceeded = stepVisits
    .filter((visit) => visit.status === "succeeded")
    .at(-1);

  return {
    nodeId: (lastSucceeded ?? stepVisits.at(-1))?.nodeId ?? null,
    hasTrace: false,
  };
}

const toHighlight = (
  workItem: WorkItemListItemContract,
  execution: PipelineExecutionSummaryContract,
  nodeId: string | null,
): OverviewRunHighlight => ({
  executionId: execution.id,
  workItemId: workItem.id,
  workItemTitle: execution.workItemTitle || workItem.title,
  nodeId,
});

/**
 * The guest tour's targets.
 *
 * Resolution is anchored on the work items list rather than on the executions
 * list, for two reasons: the list item contract already carries
 * `latestExecutionStatus` (Phase 1), so one request yields both candidates; and
 * the list's default ordering is the one the visitor sees on the Work Items
 * tab, so "the featured run" is the run belonging to the item sitting at the
 * top of that table rather than an unrelated row further down.
 *
 * Cost: one work-items page, up to two single-row execution lookups, one
 * execution detail, and up to {@link TRACE_PROBE_STEP_LIMIT} artifact probes —
 * server-side, mostly in parallel.
 */
export async function loadProjectOverviewTour(
  projectId: string,
  requestHeaders: RequestHeaders,
): Promise<ProjectOverviewTour> {
  try {
    const apiClient = await getScarnApiClient();
    const { data: workItemsPage } = await apiClient.api
      .projects({ projectId: parseUuidV7(projectId) })
      ["work-items"].get({
        query: { page: 1, pageSize: WORK_ITEM_SCAN_PAGE_SIZE },
        headers: requestHeaders,
      });

    const items = workItemsPage?.items ?? [];
    const succeededItem =
      items.find((item) => item.latestExecutionStatus === "succeeded") ?? null;
    const runningItem =
      items.find((item) => item.latestExecutionStatus === "active") ?? null;

    const [succeededExecution, runningExecution] = await Promise.all([
      succeededItem
        ? findLatestExecution(
            apiClient,
            requestHeaders,
            projectId,
            succeededItem,
            "succeeded",
          )
        : null,
      runningItem
        ? findLatestExecution(
            apiClient,
            requestHeaders,
            projectId,
            runningItem,
            "running",
          )
        : null,
    ]);

    const inProgress =
      runningItem && runningExecution
        ? toHighlight(
            runningItem,
            runningExecution,
            // Open nodes are ones the run is visiting right now, so the link
            // needs no detail fetch to confirm.
            runningExecution.openNodeIds[0] ?? null,
          )
        : null;

    if (!succeededItem || !succeededExecution) {
      return { ...EMPTY_TOUR, inProgress };
    }

    const { data: detail } = await apiClient.api["pipeline-executions"]({
      pipelineExecutionId: parseUuidV7(succeededExecution.id),
    }).get({ headers: requestHeaders });

    const { nodeId, hasTrace } = detail
      ? await resolveRunStep(apiClient, requestHeaders, detail)
      : { nodeId: null, hasTrace: false };
    const transcript = toHighlight(succeededItem, succeededExecution, nodeId);

    return {
      transcript,
      trace: hasTrace ? transcript : null,
      inProgress,
    };
  } catch {
    return EMPTY_TOUR;
  }
}
