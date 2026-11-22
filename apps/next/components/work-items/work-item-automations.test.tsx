import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { JSDOM } from "jsdom";
import { parseUuidV7 } from "@scarn/api/frontend-contracts";
import type {
  AutomationContract,
  WorkItemAutomationContract,
  WorkItemContract,
} from "@scarn/api/frontend-contracts";
import { installDom } from "@/tests/support/install-dom";

const PROJECT_ID = "01966a2c-9494-7db5-aa46-0f8f5cbbe000";
const WORK_ITEM_ID = "01966a2c-9494-7db5-aa46-0f8f5cbbe001";

function buildAutomation(
  overrides: Partial<AutomationContract> = {},
): AutomationContract {
  return {
    id: "01966a2c-9494-7db5-aa46-0f8f5cbbe100",
    projectId: PROJECT_ID,
    key: "wayfinder",
    title: "Wayfinder",
    scope: "workItem",
    enabled: false,
    latestVersion: null,
    createdAt: "2026-04-26T12:00:00.000Z",
    updatedAt: "2026-04-26T12:00:00.000Z",
    ...overrides,
  } as AutomationContract;
}

const attachmentOf = (
  automation: AutomationContract,
): WorkItemAutomationContract =>
  ({
    workItemId: WORK_ITEM_ID,
    automation,
    attachedByUserId: "01966a2c-9494-7db5-aa46-0f8f5cbbe200",
    attachedAt: "2026-04-26T12:00:00.000Z",
  }) as WorkItemAutomationContract;

const wayfinder = buildAutomation();
const triage = buildAutomation({
  id: parseUuidV7("01966a2c-9494-7db5-aa46-0f8f5cbbe101"),
  key: "triage",
  title: "Triage",
});
const projectDefault = buildAutomation({
  id: parseUuidV7("01966a2c-9494-7db5-aa46-0f8f5cbbe102"),
  key: "default",
  title: "Default",
  scope: "project",
  enabled: true,
});

type ApiResult = { data: unknown; error: unknown };

let attachedResult: ApiResult = { data: [], error: null };
const attachCalls: string[] = [];
const detachCalls: string[] = [];
const listProjectAutomationsMock = mock(() =>
  Promise.resolve({ data: [projectDefault, triage, wayfinder], error: null }),
);

void mock.module("@/app/_lib/scarn-browser-api-client", () => ({
  getBrowserScarnApiClient: () => ({
    api: {
      projects: () => ({
        automations: { get: listProjectAutomationsMock },
      }),
      "work-items": () => ({
        automations: Object.assign(
          ({ key }: { key: string }) => ({
            post: () => {
              attachCalls.push(key);
              const automation = [triage, wayfinder].find(
                (entry) => entry.key === key,
              );
              return Promise.resolve({
                data: automation ? attachmentOf(automation) : null,
                error: null,
              });
            },
            delete: () => {
              detachCalls.push(key);
              return Promise.resolve({ data: { detached: true }, error: null });
            },
          }),
          { get: () => Promise.resolve(attachedResult) },
        ),
      }),
    },
  }),
}));

const { WorkItemAutomations } = await import("./work-item-automations");
const { ProjectRouteProvider } =
  await import("@/components/project-route-context");

const renderAutomations = ({
  permissions = ["work-items:update"],
  state = "open",
}: {
  permissions?: string[];
  state?: WorkItemContract["state"];
} = {}) =>
  render(
    <ProjectRouteProvider
      username="tester"
      projectSlug="demo"
      projectId={PROJECT_ID}
      isMember
      permissions={permissions}
    >
      <WorkItemAutomations
        projectId={PROJECT_ID}
        workItem={{ id: WORK_ITEM_ID, state } as WorkItemContract}
      />
    </ProjectRouteProvider>,
  );

describe("WorkItemAutomations", () => {
  let dom: JSDOM;

  beforeEach(() => {
    dom = installDom({ url: "https://app.scarn.io/" });

    type WithIeEvents = { attachEvent?: () => void; detachEvent?: () => void };
    for (const prototype of [
      dom.window.HTMLInputElement.prototype,
      dom.window.Element.prototype,
    ] as unknown as WithIeEvents[]) {
      prototype.attachEvent = () => {};
      prototype.detachEvent = () => {};
    }

    attachedResult = { data: [attachmentOf(wayfinder)], error: null };
    attachCalls.length = 0;
    detachCalls.length = 0;
    listProjectAutomationsMock.mockClear();
  });

  afterEach(() => {
    cleanup();
    dom.window.close();
  });

  test("attaches a work-item automation picked from the project's", async () => {
    const view = renderAutomations();

    await view.findByText("Wayfinder");
    fireEvent.mouseDown(await view.findByLabelText("Attach automation"));

    expect(await view.findByRole("option", { name: "Triage" })).toBeTruthy();
    expect(view.queryByRole("option", { name: "Default" })).toBeNull();
    expect(view.queryByRole("option", { name: "Wayfinder" })).toBeNull();

    fireEvent.click(view.getByRole("option", { name: "Triage" }));

    await waitFor(() => {
      expect(attachCalls).toEqual(["triage"]);
    });
    expect(await view.findByText("Triage")).toBeTruthy();
  });

  test("detaches an attached automation", async () => {
    const view = renderAutomations();

    fireEvent.click(await view.findByLabelText("Detach automation Wayfinder"));

    await waitFor(() => {
      expect(detachCalls).toEqual(["wayfinder"]);
    });
    expect(await view.findByText("None")).toBeTruthy();
  });

  test("shows attachments read-only without work-items:update", async () => {
    const view = renderAutomations({ permissions: [] });

    expect(await view.findByText("Wayfinder")).toBeTruthy();
    expect(view.queryByLabelText("Detach automation Wayfinder")).toBeNull();
    expect(view.queryByLabelText("Attach automation")).toBeNull();
    expect(listProjectAutomationsMock).not.toHaveBeenCalled();
  });

  test("offers no attach on a closed work item but still allows detach", async () => {
    const view = renderAutomations({ state: "closed" });

    expect(
      await view.findByLabelText("Detach automation Wayfinder"),
    ).toBeTruthy();
    await waitFor(() => {
      expect(listProjectAutomationsMock).toHaveBeenCalled();
    });
    expect(view.queryByLabelText("Attach automation")).toBeNull();
  });
});
