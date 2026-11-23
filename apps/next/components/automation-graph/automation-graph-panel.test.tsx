import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import type { AutomationContract } from "@scarn/api/frontend-contracts";
import {
  layoutAutomationRound,
  type AutomationRoundModel,
} from "@scarn/pipeline-studio-ui";
import type { Grant } from "@scarn/sdk/definitions/steps";
import { installDom } from "@/tests/support/install-dom";

// React Flow needs browser APIs jsdom lacks, so the view is a stand-in that
// lists the real layout's lanes, nodes and edge labels; the layout and the
// view themselves are covered in `@scarn/pipeline-studio-ui`.
void mock.module("@scarn/pipeline-studio-ui/view", () => ({
  ROUND_EDGE_COLOR: { route: "#000", declared: "#000", engine: "#000" },
  ROUND_EDGE_DASH: { route: undefined, declared: "6 4", engine: "2 4" },
  AutomationRoundView: ({ model }: { model: AutomationRoundModel }) => {
    const { nodes, edges } = layoutAutomationRound(model);
    return (
      <div>
        <ul aria-label="Automation graph">
          {nodes.map((node) => (
            <li key={node.id} data-kind={node.data.kind}>
              {node.data.kind === "lane"
                ? node.data.label
                : node.data.node.label}
            </li>
          ))}
        </ul>
        <ul aria-label="Automation graph edges">
          {edges.map((edge) => (
            <li key={edge.id} data-tone={edge.data?.tone}>
              {typeof edge.label === "string" ? edge.label : ""}
            </li>
          ))}
        </ul>
      </div>
    );
  },
}));

const { AutomationGraphPanel } = await import("./automation-graph-panel");

const DOCUMENT = {
  kind: "automation",
  schemaVersion: 1,
  key: "wayfinder",
  scope: "workItem",
  rules: [
    {
      key: "plan-on-attach",
      event: "self.attached",
      next: { routes: [{ kind: "step", to: "plan", on: "workItem" }] },
    },
    {
      key: "route-ready-children",
      event: "child.ready",
      next: {
        routes: [
          {
            when: {
              path: "event.child.labels",
              op: "contains",
              value: "wayfinder:research",
            },
            kind: "step",
            to: "research",
            on: "child",
          },
        ],
      },
    },
    {
      key: "replan-on-child-closed",
      event: "child.closed",
      next: { routes: [{ kind: "step", to: "plan", on: "workItem" }] },
    },
  ],
};

const DEFAULT_DOCUMENT = {
  kind: "automation",
  schemaVersion: 1,
  key: "default",
  scope: "project",
  rules: [
    {
      key: "on-work-item-ready",
      event: "workItem.ready",
      next: {
        routes: [{ kind: "pipeline", to: "build", on: "workItem" }],
      },
    },
  ],
};

const STEP_GRANTS: ReadonlyMap<string, readonly Grant[]> = new Map([
  [
    "plan",
    [
      {
        resource: "workItem",
        action: "create",
        scope: "children",
        labels: ["wayfinder:research"],
      },
    ],
  ],
  ["research", [{ resource: "workItem", action: "close", scope: "self" }]],
]);

const buildAutomation = (
  overrides: Partial<AutomationContract> = {},
  document: Record<string, unknown> = DOCUMENT,
): AutomationContract =>
  ({
    id: "019e9a92-b432-73e8-9341-3519156fa801",
    projectId: "019e9a92-b432-73e8-9341-3519156fa900",
    key: "wayfinder",
    title: "Wayfinder",
    scope: "workItem",
    enabled: true,
    latestVersion: {
      id: "019e9a92-b432-73e8-9341-3519156fa802",
      version: 3,
      schemaVersion: 1,
      contentHash: "hash",
      document,
      publishedAt: "2026-06-05T12:00:00.000Z",
    },
    createdAt: "2026-06-05T12:00:00.000Z",
    updatedAt: "2026-06-05T12:00:00.000Z",
    ...overrides,
  }) as AutomationContract;

const PIPELINES: ReadonlyMap<string, string> = new Map([
  ["build", "Build Pipeline"],
]);

const renderPanel = (automation: AutomationContract) =>
  render(
    <AutomationGraphPanel
      automation={automation}
      pipelineNames={PIPELINES}
      stepGrants={STEP_GRANTS}
    />,
  );

const expectNoRunOrExecutionText = (container: HTMLElement) => {
  const text = container.textContent;
  expect(text).not.toMatch(/\bruns?\b/i);
  expect(text).not.toMatch(/execution/i);
};

describe("AutomationGraphPanel", () => {
  beforeEach(() => {
    installDom({ url: "https://app.scarn.io/" });
  });

  afterEach(() => {
    cleanup();
  });

  test("shows the header, wayfinder's lanes, a soft link and the legend", () => {
    const view = renderPanel(buildAutomation({ enabled: false }));
    for (const text of [
      "Wayfinder",
      "wayfinder",
      "v3",
      "Work item automation",
      "Disabled",
    ]) {
      expect(view.getByText(text)).toBeTruthy();
    }
    const graph = view.getByRole("list", { name: "Automation graph" });
    const lanes = [...graph.querySelectorAll('li[data-kind="lane"]')].map(
      (item) => item.textContent,
    );
    expect(lanes).toContain("Automation · events & rules");
    expect(lanes).toContain("This work item");
    expect(lanes).toContain("Child work items");
    const edges = view.getByRole("list", { name: "Automation graph edges" });
    const softLabels = [
      ...edges.querySelectorAll('li[data-tone="declared"]'),
    ].map((item) => item.textContent);
    expect(softLabels).toContain("creates children");
    const legend = view.getByLabelText("Edge legend");
    for (const text of ["Route", "Soft link (step grants)", "Engine"]) {
      expect(legend.textContent).toContain(text);
    }
    expect(view.getByText(/Read-only\./)).toBeTruthy();
    expect(view.getByText(/^Published /)).toBeTruthy();
    expectNoRunOrExecutionText(view.container);
  });

  test("default renders no children lane", () => {
    const view = renderPanel(
      buildAutomation(
        { key: "default", title: "Default", scope: "project" },
        DEFAULT_DOCUMENT,
      ),
    );
    const graph = view.getByRole("list", { name: "Automation graph" });
    const lanes = [...graph.querySelectorAll('li[data-kind="lane"]')].map(
      (item) => item.textContent,
    );
    expect(lanes).toContain("Automation · events & rules");
    expect(lanes).not.toContain("Child work items");
    expect(graph.textContent).toContain("Build Pipeline");
  });

  test("an enabled project automation shows its scope and no Disabled chip", () => {
    const view = renderPanel(
      buildAutomation(
        { scope: "project" },
        {
          ...DOCUMENT,
          scope: "project",
          rules: [
            {
              key: "on-work-item-created",
              event: "workItem.created",
              next: { routes: [{ kind: "skip" }] },
            },
          ],
        },
      ),
    );
    expect(view.getByText("Project automation")).toBeTruthy();
    expect(view.queryByText("Disabled")).toBeNull();
  });

  test("an unpublished automation shows no graph", () => {
    const view = renderPanel(buildAutomation({ latestVersion: null }));
    expect(view.getByText("No published version")).toBeTruthy();
    expect(view.queryByRole("list", { name: "Automation graph" })).toBeNull();
    expect(view.queryByText(/^Published /)).toBeNull();
    expectNoRunOrExecutionText(view.container);
  });

  test("a malformed document shows an error naming the automation", () => {
    const view = renderPanel(
      buildAutomation({}, { kind: "automation", rules: "nope" }),
    );
    expect(view.getByRole("alert").textContent).toContain(
      'Automation "wayfinder"',
    );
    expect(view.queryByRole("list", { name: "Automation graph" })).toBeNull();
  });

  test("a version with no rules says nothing routes", () => {
    const view = renderPanel(buildAutomation({}, { ...DOCUMENT, rules: [] }));
    expect(view.getByText("No rules")).toBeTruthy();
    expect(view.queryByRole("list", { name: "Automation graph" })).toBeNull();
  });
});
