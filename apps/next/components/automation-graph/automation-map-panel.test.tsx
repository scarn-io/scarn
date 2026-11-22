import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import type { AutomationContract } from "@scarn/api/frontend-contracts";
import { installDom } from "@/tests/support/install-dom";

const PROJECT_ID = "019e9a92-b432-73e8-9341-3519156fa900";

void mock.module(
  "@/components/automation-graph/automation-graph-panel",
  () => ({
    AutomationGraphPanel: ({
      automation,
    }: {
      automation: AutomationContract;
    }) => <section aria-label="Automation panel">{automation.key}</section>,
  }),
);

const buildAutomation = (
  overrides: Partial<AutomationContract> = {},
): AutomationContract =>
  ({
    id: "019e9a92-b432-73e8-9341-3519156fa801",
    projectId: PROJECT_ID,
    key: "triage",
    title: "Triage",
    scope: "project",
    enabled: true,
    latestVersion: {
      id: "019e9a92-b432-73e8-9341-3519156fa802",
      version: 1,
      schemaVersion: 1,
      contentHash: "hash",
      document: {},
      publishedAt: "2026-06-05T12:00:00.000Z",
    },
    createdAt: "2026-06-05T12:00:00.000Z",
    updatedAt: "2026-06-05T12:00:00.000Z",
    ...overrides,
  }) as AutomationContract;

const triage = buildAutomation();
const wayfinder = buildAutomation({
  key: "wayfinder",
  title: null,
  scope: "workItem",
  enabled: false,
  latestVersion: null,
});

type ApiResult = { data: unknown; error: unknown };

let automationsResult: ApiResult = { data: [], error: null };
let automationLoads = 0;

void mock.module("@/app/_lib/scarn-browser-api-client", () => ({
  getBrowserScarnApiClient: () => ({
    api: {
      "step-definitions": {
        get: () => Promise.resolve({ data: [], error: null }),
      },
      projects: () => ({
        automations: {
          get: () => {
            automationLoads += 1;
            return Promise.resolve(automationsResult);
          },
        },
        "pipeline-definitions": {
          get: () => Promise.resolve({ data: [], error: null }),
        },
      }),
    },
  }),
}));

const { AutomationMapPanel } = await import("./automation-map-panel");
const { ProjectRouteProvider } =
  await import("@/components/project-route-context");

const renderPanel = () =>
  render(
    <ProjectRouteProvider
      username="tester"
      projectSlug="demo"
      projectId={PROJECT_ID}
      isMember
    >
      <AutomationMapPanel projectId={PROJECT_ID} />
    </ProjectRouteProvider>,
  );

const expectNoRunOrExecutionText = (container: HTMLElement) => {
  const text = container.textContent;
  expect(text).not.toMatch(/\bruns?\b/i);
  expect(text).not.toMatch(/execution/i);
};

const openSelect = async (view: ReturnType<typeof render>) => {
  fireEvent.mouseDown(await view.findByLabelText("Automation"));
  return await within(document.body).findByRole("listbox");
};

describe("AutomationMapPanel", () => {
  beforeEach(() => {
    installDom({ url: "https://app.scarn.io/" });
    automationLoads = 0;
  });

  afterEach(() => {
    cleanup();
  });

  test("loads, then asks for an automation to be selected", async () => {
    automationsResult = { data: [triage, wayfinder], error: null };
    const view = renderPanel();
    expect(view.getByText("Loading automations")).toBeTruthy();
    expect(await view.findByText("No selected automation")).toBeTruthy();
    expect(view.queryByRole("region", { name: "Automation panel" })).toBeNull();
    expectNoRunOrExecutionText(view.container);
  });

  test("lists every automation and shows the picked one's panel", async () => {
    automationsResult = { data: [wayfinder, triage], error: null };
    const view = renderPanel();
    const listbox = await openSelect(view);
    const options = within(listbox)
      .getAllByRole("option")
      .map((option) => option.textContent);
    expect(options).toEqual([
      "Select an automation",
      "Triage",
      "wayfinder (disabled) (unpublished)",
    ]);

    fireEvent.click(within(listbox).getByText("Triage"));
    const panel = await view.findByRole("region", { name: "Automation panel" });
    expect(panel.textContent).toBe("triage");
    expect(view.queryByText("No selected automation")).toBeNull();
    expectNoRunOrExecutionText(view.container);
  });

  test("explains the empty state and links to Settings", async () => {
    automationsResult = { data: [], error: null };
    const view = renderPanel();
    expect(await view.findByText("No automations yet")).toBeTruthy();
    expect(view.getByText("scarn pipelines push")).toBeTruthy();
    const settings = view.getByRole("link", { name: /Settings/ });
    expect(settings.getAttribute("href")).toBe("/tester/demo/settings");
    expectNoRunOrExecutionText(view.container);
  });

  test("shows an error with a Retry that loads again", async () => {
    automationsResult = { data: null, error: { status: 500 } };
    const view = renderPanel();
    const alert = await view.findByRole("alert");
    expect(alert.textContent).toContain(
      "Couldn't load automations: Failed to load automations",
    );
    expectNoRunOrExecutionText(view.container);

    automationsResult = { data: [triage], error: null };
    fireEvent.click(view.getByRole("button", { name: "Retry" }));
    await waitFor(() => {
      expect(view.queryByText("No selected automation")).toBeTruthy();
    });
    expect(automationLoads).toBe(2);
  });
});
