/**
 * The Pipelines & Automations page body: automation rows with their switch,
 * what they start and their runs link; pipeline cards with live counts,
 * links and node clicks; the Step Library below; guests read only.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ReactNode } from "react";
import type {
  AutomationListItemContract,
  PipelineDefinitionContract,
} from "@scarn/api/frontend-contracts";
import { installDom } from "@/tests/support/install-dom";

const dom = installDom({
  url: "https://app.scarn.io/",
  pretendToBeVisual: true,
});
Object.assign(globalThis, {
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
});

const {
  AUTOMATION_ID,
  HELD_TASK_ID,
  IDLE_AUTOMATION_ID,
  PIPELINE_ID,
  PROJECT_ID,
  SCHEDULE_ID,
  STARTED_TASK_ID,
  poller,
  shipIt,
  triage,
  wayfinder,
} = await import("./pipeline-page-tabs-fixtures");

const state = {
  automations: [] as AutomationListItemContract[],
  runNow: [] as { key: string; ruleKey: string }[],
  runNowResponse: { data: null, error: null } as {
    data: unknown;
    error: unknown;
  },
  definitions: [] as PipelineDefinitionContract[],
  toggles: [] as { key: string; enabled: boolean }[],
  pushed: [] as string[],
  runsQueries: [] as Record<string, unknown>[],
  liveCountCalls: 0,
};

const toggle = (key: string, enabled: boolean) => () => {
  state.toggles.push({ key, enabled });
  const automation = state.automations.find((entry) => entry.key === key);
  return Promise.resolve({ data: { ...automation, enabled }, error: null });
};

void mock.module("@/app/_lib/scarn-browser-api-client", () => ({
  getBrowserScarnApiClient: () => ({
    api: {
      "step-definitions": {
        get: () => Promise.resolve({ data: [], error: null }),
      },
      projects: () => ({
        automations: Object.assign(
          ({ key }: { key: string }) => ({
            enable: { post: toggle(key, true) },
            disable: { post: toggle(key, false) },
            schedules: ({ ruleKey }: { ruleKey: string }) => ({
              runs: {
                post: () => {
                  state.runNow.push({ key, ruleKey });
                  return Promise.resolve(state.runNowResponse);
                },
              },
            }),
          }),
          {
            get: () =>
              Promise.resolve({ data: state.automations, error: null }),
          },
        ),
        "pipeline-definitions": {
          get: () => Promise.resolve({ data: state.definitions, error: null }),
          "live-counts": {
            get: () => {
              state.liveCountCalls += 1;
              return Promise.resolve({
                data: {
                  pipelines: [
                    {
                      pipelineDefinitionId: PIPELINE_ID,
                      inProgress: 4,
                      doneThisWeek: 9,
                      nodes: {
                        review: { running: 2, waiting: 1, failed: 0, lanes: 0 },
                      },
                    },
                  ],
                },
                error: null,
              });
            },
          },
        },
        runs: {
          get: ({ query }: { query: Record<string, unknown> }) => {
            state.runsQueries.push(query);
            return Promise.resolve({
              data: {
                runs: [],
                nextCursor: null,
                counts: {
                  tabs: { "needs-you": 0, open: 3, finished: 0, all: 3 },
                  overall: { inProgress: 3, needsYou: false },
                  startedBy: [
                    {
                      filter: "me",
                      label: "You",
                      inProgress: 1,
                      needsYou: false,
                    },
                    {
                      filter: AUTOMATION_ID,
                      label: "Triage new issues",
                      inProgress: 2,
                      needsYou: false,
                    },
                  ],
                  whatRan: [],
                },
              },
              error: null,
            });
          },
        },
      }),
    },
  }),
}));

void mock.module("next/navigation", () => ({
  useRouter: () => ({
    push: (href: string) => {
      state.pushed.push(href);
    },
    replace: () => {},
    refresh: () => {},
  }),
  usePathname: () => "/alice/demo/pipelines",
  useSearchParams: () => new URLSearchParams(),
}));

void mock.module("@/components/pipeline-graph/pipeline-graph-view", () => ({
  PipelineGraphView: ({
    nodes,
    decorateNode,
    onSelectNode,
  }: {
    nodes: { id: string }[];
    decorateNode?: (node: { id: string }) => { captionSuffix?: string | null };
    onSelectNode?: (nodeId: string) => void;
  }) => (
    <ul aria-label="Pipeline graph">
      {nodes.map((node) => (
        <li key={node.id}>
          <button
            type="button"
            onClick={() => {
              onSelectNode?.(node.id);
            }}
          >
            {node.id}
          </button>
          <span>{decorateNode?.(node).captionSuffix ?? ""}</span>
        </li>
      ))}
    </ul>
  ),
}));

void mock.module("./step-library-tab", () => ({
  StepLibraryTab: () => <div data-testid="step-library" />,
}));

void mock.module("./pipeline-builder-modal", () => ({
  PipelineBuilderModal: () => null,
}));

void mock.module("@/components/automation-graph/automation-map-panel", () => ({
  AutomationMapPanel: () => <div data-testid="automation-map" />,
}));

const { cleanup, fireEvent, render, waitFor, within } =
  await import("@testing-library/react");
const { ProjectRouteProvider } =
  await import("@/components/project-route-context");
const { PipelinePageTabs } = await import("./pipeline-page-tabs");

const withRoute = (
  children: ReactNode,
  { isMember = true, permissions = ["pipelines:write"] } = {},
) => (
  <ProjectRouteProvider
    username="alice"
    projectSlug="demo"
    projectId={PROJECT_ID}
    isMember={isMember}
    permissions={isMember ? permissions : []}
  >
    {children}
  </ProjectRouteProvider>
);

const renderPage = async (options?: Parameters<typeof withRoute>[1]) => {
  const view = render(
    withRoute(
      <PipelinePageTabs projectId={PROJECT_ID} projectRef="alice/demo" />,
      options,
    ),
  );
  await view.findByText("Triage new issues");
  await view.findByRole("article", { name: "Ship it" });
  return view;
};

const automationsSection = (view: Awaited<ReturnType<typeof renderPage>>) =>
  within(view.getByRole("region", { name: "Automations" }));

const switchInput = (
  section: ReturnType<typeof automationsSection>,
  name: string,
): HTMLInputElement => {
  const element = section.getByLabelText(`Enable ${name}`);
  if (!(element instanceof window.HTMLInputElement)) {
    throw new Error(`No switch for ${name}`);
  }
  return element;
};

const card = (view: Awaited<ReturnType<typeof renderPage>>) =>
  within(view.getByRole("article", { name: "Ship it" }));

describe("PipelinePageTabs", () => {
  beforeEach(() => {
    state.automations = [triage, wayfinder];
    state.definitions = [shipIt];
    state.toggles = [];
    state.runNow = [];
    state.pushed = [];
    state.runsQueries = [];
    state.liveCountCalls = 0;
  });

  afterEach(() => {
    cleanup();
  });

  test("leads with the page title and New Pipeline", async () => {
    const view = await renderPage();

    expect(
      view.getByRole("heading", { name: "Pipelines & Automations" }),
    ).toBeTruthy();
    expect(
      view.getByText(
        "Automations decide when a run starts; pipelines are what runs.",
      ),
    ).toBeTruthy();
    expect(view.getByRole("button", { name: "New Pipeline" })).toBeTruthy();
  });

  test("lists automations with their scope, what they start and runs in progress", async () => {
    const view = await renderPage();
    const section = automationsSection(view);

    expect(section.getByText("whole project")).toBeTruthy();
    expect(section.getByText("one work item")).toBeTruthy();
    expect(section.getByText("Starts Ship it · label")).toBeTruthy();
    await waitFor(() => {
      expect(
        section
          .getByRole("link", { name: "2 in progress →" })
          .getAttribute("href"),
      ).toBe(`/alice/demo/runs?by=${AUTOMATION_ID}`);
    });
    expect(
      section
        .getByRole("link", { name: "0 in progress →" })
        .getAttribute("href"),
    ).toBe(`/alice/demo/runs?by=${IDLE_AUTOMATION_ID}`);
    expect(state.runsQueries[0]).toMatchObject({ status: "open", limit: 1 });
  });

  test("switches a project automation on; work-item automations have no switch", async () => {
    const view = await renderPage();
    const section = automationsSection(view);
    const input = switchInput(section, "Triage new issues");

    fireEvent.click(input);

    await waitFor(() => {
      expect(switchInput(section, "Triage new issues").checked).toBe(true);
    });
    expect(state.toggles).toEqual([{ key: "triage", enabled: true }]);
    expect(section.queryByLabelText("Enable Wayfinder")).toBeNull();
  });

  test("shows a schedule rule's summary with its history link", async () => {
    state.automations = [triage, poller];
    const view = await renderPage();
    const schedule = within(await view.findByTestId("automation-schedule"));

    expect(schedule.getByText("hourly")).toBeTruthy();
    expect(schedule.getByText("0 * * * * Europe/Paris")).toBeTruthy();
    expect(schedule.getByText(/^next /)).toBeTruthy();
    expect(schedule.getByText("Failed")).toBeTruthy();
    expect(schedule.getByTestId("schedule-failure-streak").textContent).toBe(
      "3 failures in a row",
    );
    expect(
      schedule.getByTestId("schedule-last-error").getAttribute("title"),
    ).toContain("Step poll-linear has no active version");
    expect(schedule.getByText(/2× since it fired/)).toBeTruthy();
    expect(
      schedule.getByRole("link", { name: "History" }).getAttribute("href"),
    ).toBe(`/alice/demo/runs?status=all&schedule=${SCHEDULE_ID}`);
    expect(schedule.queryByRole("button", { name: "Run now" })).toBeNull();
  });

  test("Run now links the started Task", async () => {
    state.automations = [triage, poller];
    state.runNowResponse = {
      data: { taskId: STARTED_TASK_ID, scheduledFor: "2026-11-01T12:00:00Z" },
      error: null,
    };
    const view = await renderPage({ permissions: ["executions:write"] });
    const schedule = within(await view.findByTestId("automation-schedule"));

    fireEvent.click(schedule.getByRole("button", { name: "Run now" }));

    const link = await view.findByRole("link", { name: "Open the Task →" });
    expect(link.getAttribute("href")).toBe(
      `/alice/demo/runs/tasks/${STARTED_TASK_ID}`,
    );
    expect(state.runNow).toEqual([{ key: "poller", ruleKey: "hourly" }]);
  });

  test("Run now names the Tasks holding a full concurrency group", async () => {
    state.automations = [triage, poller];
    state.runNowResponse = {
      data: null,
      error: {
        status: 409,
        value: {
          status: 409,
          code: "Scarn.ConcurrencyGroupFull",
          detail: "full",
          meta: { scheduleId: SCHEDULE_ID, heldBy: [HELD_TASK_ID] },
        },
      },
    };
    const view = await renderPage({ permissions: ["executions:write"] });
    const schedule = within(await view.findByTestId("automation-schedule"));

    fireEvent.click(schedule.getByRole("button", { name: "Run now" }));

    expect(await view.findByText(/concurrency group is full/)).toBeTruthy();
    expect(
      view
        .getByRole("link", { name: HELD_TASK_ID.slice(-8) })
        .getAttribute("href"),
    ).toBe(`/alice/demo/runs/tasks/${HELD_TASK_ID}`);
  });

  test("disables the switch without pipelines:write", async () => {
    const view = await renderPage({ permissions: [] });

    expect(
      switchInput(automationsSection(view), "Triage new issues").disabled,
    ).toBe(true);
  });

  test("a member who can run pipelines but not edit them gets no New Pipeline", async () => {
    const view = await renderPage({ permissions: ["executions:write"] });

    expect(view.queryByRole("button", { name: "New Pipeline" })).toBeNull();
    expect(
      card(view).queryByRole("button", { name: "Pipeline actions" }),
    ).toBeNull();
  });

  test("a pipeline card shows its file, live counts and links to its runs", async () => {
    const view = await renderPage();

    expect(card(view).getByText("pipelines/ship-it.yaml")).toBeTruthy();
    expect(
      card(view).getByRole("button", {
        name: "Open in Studio: copy scarn pipelines studio",
      }),
    ).toBeTruthy();
    const runsLink = await card(view).findByRole("link", {
      name: "4 in progress · 9 done this week →",
    });
    expect(runsLink.getAttribute("href")).toBe(
      `/alice/demo/runs?status=all&whatRan=${PIPELINE_ID}`,
    );
    expect(card(view).getByText("2 running · 1 waiting")).toBeTruthy();
    expect(state.liveCountCalls).toBe(1);
  });

  test("clicking a node opens the runs at that node", async () => {
    const view = await renderPage();

    fireEvent.click(card(view).getByRole("button", { name: "review" }));

    expect(state.pushed).toEqual([
      `/alice/demo/runs?status=all&whatRan=${PIPELINE_ID}&at=review`,
    ]);
  });

  test("keeps the Step Library and the automation map below", async () => {
    const view = await renderPage();

    expect(view.getByTestId("step-library")).toBeTruthy();
    fireEvent.click(view.getByRole("tab", { name: "Automation map" }));
    expect(view.getByTestId("automation-map")).toBeTruthy();
    expect(view.queryByTestId("step-library")).toBeNull();
  });

  test("guests get no switch, no New Pipeline and no archive menu", async () => {
    const view = await renderPage({ isMember: false });

    expect(view.queryByRole("button", { name: "New Pipeline" })).toBeNull();
    expect(
      automationsSection(view).queryByLabelText("Enable Triage new issues"),
    ).toBeNull();
    expect(
      card(view).queryByRole("button", { name: "Pipeline actions" }),
    ).toBeNull();
  });

  test("an empty project points at scarn init", async () => {
    state.definitions = [];
    const view = render(
      withRoute(
        <PipelinePageTabs projectId={PROJECT_ID} projectRef="alice/demo" />,
      ),
    );

    expect(await view.findByText("No pipelines yet")).toBeTruthy();
    expect(view.getByText("scarn init")).toBeTruthy();
  });
});
