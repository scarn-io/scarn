import { describe, expect, mock, test } from "bun:test";

/**
 * Exercises the Overview tour's target resolution against a stub API client.
 *
 * What matters here is what the page will and will not link to: a target that
 * cannot be resolved from the project's own data must come back `null` so its
 * card is dropped, because a guest-facing card pointing at a URL that 404s is
 * worse than no card at all.
 */
const PROJECT_ID = "019e709b-574f-742c-8fda-00a1bcc71b00";
const SUCCEEDED_WORK_ITEM_ID = "019e709b-574f-742c-8fda-00a1bcc71b01";
const SUCCEEDED_EXECUTION_ID = "019e709b-574f-742c-8fda-00a1bcc71b02";
const RUNNING_WORK_ITEM_ID = "019e709b-574f-742c-8fda-00a1bcc71b11";
const RUNNING_EXECUTION_ID = "019e709b-574f-742c-8fda-00a1bcc71b12";
const REPRODUCE_TASK_ID = "019e709b-574f-742c-8fda-00a1bcc71b21";
const FIX_TASK_ID = "019e709b-574f-742c-8fda-00a1bcc71b22";

type WorkItemRow = {
  id: string;
  title: string;
  latestExecutionStatus: string | null;
};

type StubOptions = {
  workItems?: WorkItemRow[];
  /** Task ids that answer with a `playwright-trace` artifact. */
  tracedTaskIds?: string[];
  /** Make every request reject, standing in for an API outage. */
  failing?: boolean;
  /** The project's automations, as the list endpoint returns them. */
  automations?: AutomationRow[];
};

type AutomationRow = {
  key: string;
  scope: "project" | "workItem";
  enabled: boolean;
};

const ENABLED_PROJECT_AUTOMATION: AutomationRow = {
  key: "default",
  scope: "project",
  enabled: true,
};

const WORK_ITEMS: WorkItemRow[] = [
  {
    id: SUCCEEDED_WORK_ITEM_ID,
    title: "Checkout crashes when applying a coupon",
    latestExecutionStatus: "succeeded",
  },
  {
    id: RUNNING_WORK_ITEM_ID,
    title: "Search returns stale results after a sync",
    latestExecutionStatus: "active",
  },
  {
    id: "019e709b-574f-742c-8fda-00a1bcc71b31",
    title: "Untouched backlog stub",
    latestExecutionStatus: null,
  },
];

const executionSummary = (
  id: string,
  workItemId: string,
  title: string,
  status: string,
  openNodeId: string | null,
) => ({
  id,
  projectId: PROJECT_ID,
  workItemId,
  workItemTitle: title,
  status,
  openNodeIds: openNodeId === null ? [] : [openNodeId],
});

const stepVisit = (nodeId: string, taskId: string, createdAt: string) => ({
  id: `${nodeId}-visit`,
  nodeId,
  nodeKind: "step",
  status: "succeeded",
  resultTaskId: taskId,
  tasks: [{ taskId, attemptNumber: 1, status: "succeeded" }],
  createdAt,
});

/** Two succeeded step visits, listed out of order: Reproduce then Fix. */
const EXECUTION_DETAIL = {
  id: SUCCEEDED_EXECUTION_ID,
  projectId: PROJECT_ID,
  workItemId: SUCCEEDED_WORK_ITEM_ID,
  workItemTitle: "Checkout crashes when applying a coupon",
  status: "succeeded",
  visits: [
    stepVisit("fix", FIX_TASK_ID, "2026-01-01T00:02:00.000Z"),
    stepVisit("reproduce", REPRODUCE_TASK_ID, "2026-01-01T00:01:00.000Z"),
  ],
  laneGroups: [],
  lanes: [],
};

/** Project-wide execution totals by `status` filter ("all" when unfiltered). */
const EXECUTION_TOTALS: Record<string, number> = {
  all: 7,
  running: 2,
  succeeded: 4,
};

const buildStubApiClient = (options: StubOptions) => {
  const workItems = options.workItems ?? WORK_ITEMS;
  const traced = new Set(options.tracedTaskIds ?? []);
  const failIfConfigured = () => {
    if (options.failing) throw new Error("API unavailable");
  };

  const listExecutions = (workItemId: string | undefined) => {
    failIfConfigured();
    if (workItemId === SUCCEEDED_WORK_ITEM_ID) {
      return {
        data: {
          items: [
            executionSummary(
              SUCCEEDED_EXECUTION_ID,
              SUCCEEDED_WORK_ITEM_ID,
              "Checkout crashes when applying a coupon",
              "succeeded",
              null,
            ),
          ],
        },
      };
    }
    if (workItemId === RUNNING_WORK_ITEM_ID) {
      return {
        data: {
          items: [
            executionSummary(
              RUNNING_EXECUTION_ID,
              RUNNING_WORK_ITEM_ID,
              "Search returns stale results after a sync",
              "running",
              "evaluate",
            ),
          ],
        },
      };
    }
    return { data: { items: [] } };
  };

  const executionsList = {
    get: ({ query }: { query: { workItemId?: string; status?: string } }) => {
      if (query.workItemId === undefined) {
        failIfConfigured();
        return Promise.resolve({
          data: {
            items: [],
            pagination: {
              total: EXECUTION_TOTALS[query.status ?? "all"] ?? 0,
            },
          },
        });
      }
      return Promise.resolve(listExecutions(query.workItemId));
    },
  };

  const executions = Object.assign(
    () => ({
      get: () => {
        failIfConfigured();
        return Promise.resolve({ data: EXECUTION_DETAIL });
      },
    }),
    executionsList,
  );

  return {
    api: {
      projects: () => ({
        "work-items": {
          get: () => {
            failIfConfigured();
            return Promise.resolve({
              data: {
                items: workItems,
                pagination: { total: workItems.length },
              },
            });
          },
        },
        "pipeline-definitions": {
          get: () => {
            failIfConfigured();
            return Promise.resolve({ data: [] });
          },
        },
        integrations: {
          get: () => {
            failIfConfigured();
            return Promise.resolve({
              data: [
                {
                  id: "019e709b-574f-742c-8fda-00a1bcc71b51",
                  platform: "github",
                  status: "active",
                  installationId: "42",
                },
              ],
            });
          },
        },
        automations: {
          get: () => {
            failIfConfigured();
            return Promise.resolve({
              data: options.automations ?? [ENABLED_PROJECT_AUTOMATION],
            });
          },
        },
      }),
      "pipeline-executions": executions,
      "task-runs": (params: { taskRunId: string }) => ({
        artifacts: {
          get: () => {
            failIfConfigured();
            return Promise.resolve({
              data: traced.has(params.taskRunId)
                ? [{ kind: "playwright-trace" }]
                : [{ kind: "log" }],
            });
          },
        },
      }),
    },
  };
};

let stubOptions: StubOptions = {};

void mock.module("@/app/_lib/scarn-api-client", () => ({
  getScarnApiClient: () => Promise.resolve(buildStubApiClient(stubOptions)),
  getScarnApiRequestHeaders: () => Promise.resolve({}),
}));

const { loadProjectOverviewCounts, loadProjectOverviewTour } =
  await import("./project-overview-server");

const loadTour = (options: StubOptions = {}) => {
  stubOptions = options;
  return loadProjectOverviewTour(PROJECT_ID, {});
};

describe("loadProjectOverviewTour", () => {
  test("prefers the step that recorded a Playwright trace", async () => {
    const tour = await loadTour({
      tracedTaskIds: [REPRODUCE_TASK_ID],
    });

    expect(tour.transcript).toEqual({
      executionId: SUCCEEDED_EXECUTION_ID,
      workItemId: SUCCEEDED_WORK_ITEM_ID,
      workItemTitle: "Checkout crashes when applying a coupon",
      nodeId: "reproduce",
    });
    // Same run and step: two framings of one piece of content.
    expect(tour.trace).toEqual(tour.transcript);
  });

  test("drops the trace target but keeps the transcript when no step has a trace", async () => {
    const tour = await loadTour();

    expect(tour.trace).toBeNull();
    // Falls back to the last succeeded step visit, ordered by creation.
    expect(tour.transcript?.nodeId).toBe("fix");
  });

  test("points the in-progress target at the step the run is currently on", async () => {
    const tour = await loadTour();

    expect(tour.inProgress).toEqual({
      executionId: RUNNING_EXECUTION_ID,
      workItemId: RUNNING_WORK_ITEM_ID,
      workItemTitle: "Search returns stale results after a sync",
      nodeId: "evaluate",
    });
  });

  test("returns no targets at all for a project with no runs", async () => {
    const tour = await loadTour({
      workItems: [
        {
          id: "019e709b-574f-742c-8fda-00a1bcc71b41",
          title: "Nothing has run yet",
          latestExecutionStatus: null,
        },
      ],
    });

    expect(tour).toEqual({ transcript: null, trace: null, inProgress: null });
  });

  test("returns no targets for an empty project", async () => {
    const tour = await loadTour({ workItems: [] });

    expect(tour).toEqual({ transcript: null, trace: null, inProgress: null });
  });

  test("degrades to no targets rather than throwing when the API fails", async () => {
    const tour = await loadTour({ failing: true });

    expect(tour).toEqual({ transcript: null, trace: null, inProgress: null });
  });
});

describe("loadProjectOverviewCounts", () => {
  const loadCounts = (options: StubOptions = {}) => {
    stubOptions = options;
    return loadProjectOverviewCounts({ id: PROJECT_ID }, {});
  };

  test("reads totals, succeeded runs, integrations, and the enabled project automation", async () => {
    const counts = await loadCounts();

    expect(counts).toEqual({
      workItems: WORK_ITEMS.length,
      executions: 7,
      runningExecutions: 2,
      succeededExecutions: 4,
      pipelines: 0,
      integrations: [{ platform: "github", status: "active" }],
      hasEnabledProjectAutomation: true,
    });
  });

  test("ignores disabled project automations and work-item automations", async () => {
    const counts = await loadCounts({
      automations: [
        { key: "default", scope: "project", enabled: false },
        { key: "triage", scope: "workItem", enabled: true },
      ],
    });

    expect(counts.hasEnabledProjectAutomation).toBe(false);
  });

  test("degrades to zeroes when the API fails", async () => {
    const counts = await loadCounts({ failing: true });

    expect(counts).toEqual({
      workItems: 0,
      executions: 0,
      runningExecutions: 0,
      succeededExecutions: 0,
      pipelines: 0,
      integrations: [],
      hasEnabledProjectAutomation: false,
    });
  });
});
