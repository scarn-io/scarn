import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import type { JSDOM } from "jsdom";
import { parseUuidV7 } from "@scarn/api/frontend-contracts";
import type { AutomationContract } from "@scarn/api/frontend-contracts";
import { installDom } from "@/tests/support/install-dom";

const PROJECT_ID = "019e9a92-b432-73e8-9341-3519156fa900";

function buildAutomation(
  overrides: Partial<AutomationContract> = {},
): AutomationContract {
  return {
    id: "019e9a92-b432-73e8-9341-3519156fa801",
    projectId: PROJECT_ID,
    key: "default",
    title: "Default",
    scope: "project",
    enabled: false,
    latestVersion: {
      id: "019e9a92-b432-73e8-9341-3519156fa802",
      version: 3,
      schemaVersion: 1,
      contentHash: "hash",
      document: {},
      publishedAt: "2026-06-05T12:00:00.000Z",
    },
    createdAt: "2026-06-05T12:00:00.000Z",
    updatedAt: "2026-06-05T12:00:00.000Z",
    ...overrides,
  } as AutomationContract;
}

const { ProjectAutomationsPanel } = await import("./project-automations-panel");
const { ProjectRouteProvider } =
  await import("@/components/project-route-context");

const wayfinder = buildAutomation({
  id: parseUuidV7("019e9a92-b432-73e8-9341-3519156fa803"),
  key: "wayfinder",
  title: "Wayfinder",
  scope: "workItem",
  latestVersion: null,
});

const renderPanel = (automations: AutomationContract[]) =>
  render(
    <ProjectRouteProvider
      username="tester"
      projectSlug="demo"
      projectId={PROJECT_ID}
      isMember
      permissions={["executions:write"]}
    >
      <ProjectAutomationsPanel automations={automations} />
    </ProjectRouteProvider>,
  );

describe("ProjectAutomationsPanel", () => {
  let dom: JSDOM;

  beforeEach(() => {
    dom = installDom();
  });

  afterEach(() => {
    cleanup();
    dom.window.close();
  });

  test("lists each automation with its scope and latest version", () => {
    const view = renderPanel([buildAutomation(), wayfinder]);

    expect(view.getByText("Default")).toBeTruthy();
    expect(view.getByText("Project")).toBeTruthy();
    expect(view.getByText(/default · v3 · published/)).toBeTruthy();
    expect(view.getByText("Wayfinder")).toBeTruthy();
    expect(view.getByText("Work item")).toBeTruthy();
    expect(view.getByText("wayfinder · not published")).toBeTruthy();
  });

  test("shows whether a project automation is on, without a switch", () => {
    const view = renderPanel([buildAutomation({ enabled: true }), wayfinder]);

    expect(view.getByText("Enabled")).toBeTruthy();
    expect(view.queryByRole("switch")).toBeNull();
    expect(view.queryByRole("checkbox")).toBeNull();
  });

  test("links to Pipelines & Automations to manage them", () => {
    const view = renderPanel([buildAutomation()]);

    const link = view.getByRole("link", {
      name: "Manage automations in Pipelines & Automations →",
    });
    expect(link.getAttribute("href")).toBe("/tester/demo/pipelines");
  });
});
