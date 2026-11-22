import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import type {
  AutomationContract,
  PipelineDefinitionContract,
  StepDefinitionContract,
} from "@scarn/api/frontend-contracts";
import type { Grant } from "@scarn/sdk/definitions/steps";
import { installDom } from "@/tests/support/install-dom";

const PROJECT_ID = "019e9a92-b432-73e8-9341-3519156fa900";

function buildAutomation(
  overrides: Partial<AutomationContract> = {},
): AutomationContract {
  return {
    id: "019e9a92-b432-73e8-9341-3519156fa801",
    projectId: PROJECT_ID,
    key: "triage",
    title: "Triage",
    scope: "project",
    enabled: true,
    latestVersion: null,
    createdAt: "2026-06-05T12:00:00.000Z",
    updatedAt: "2026-06-05T12:00:00.000Z",
    ...overrides,
  } as AutomationContract;
}

const definitions = [
  { key: "triage", name: "Triage Pipeline" },
] as PipelineDefinitionContract[];

type ApiResult = { data: unknown; error: unknown };

let automationsResult: ApiResult = { data: [], error: null };
let automationLoads = 0;
let stepDefinitionsLoad: () => Promise<ApiResult> = () =>
  Promise.resolve({ data: [], error: null });

const stepDefinition = (
  key: string,
  version: number,
  status: StepDefinitionContract["status"],
  grants: Grant[],
) => ({ key, version, status, grants }) as StepDefinitionContract;

const closeSelf: Grant = {
  resource: "workItem",
  action: "close",
  scope: "self",
};
const createChildren: Grant = {
  resource: "workItem",
  action: "create",
  scope: "children",
  labels: ["task"],
};

void mock.module("@/app/_lib/scarn-browser-api-client", () => ({
  getBrowserScarnApiClient: () => ({
    api: {
      "step-definitions": { get: () => stepDefinitionsLoad() },
      projects: () => ({
        automations: {
          get: () => {
            automationLoads += 1;
            return Promise.resolve(automationsResult);
          },
        },
        "pipeline-definitions": {
          get: () => Promise.resolve({ data: definitions, error: null }),
        },
      }),
    },
  }),
}));

const { useProjectAutomations } = await import("./use-project-automations");

let reload: () => void = () => undefined;

function Probe() {
  const state = useProjectAutomations(PROJECT_ID);
  reload = state.reload;
  let text: string;
  switch (state.status) {
    case "ready":
      text = `ready:${state.automations.map((a) => a.key).join(",")}|${[
        ...state.pipelineNames,
      ]
        .map(([key, name]) => `${key}=${name}`)
        .join(",")}|${[...state.stepGrants]
        .map(
          ([key, grants]) =>
            `${key}:${grants.map((grant) => grant.action).join("+")}`,
        )
        .join(",")}`;
      break;
    case "error":
      text = `error:${state.message}`;
      break;
    default:
      text = state.status;
  }
  return <div data-testid="probe">{text}</div>;
}

const probeText = (view: ReturnType<typeof render>) =>
  view.getByTestId("probe").textContent;

describe("useProjectAutomations", () => {
  beforeEach(() => {
    installDom();
    automationLoads = 0;
    stepDefinitionsLoad = () => Promise.resolve({ data: [], error: null });
  });

  afterEach(() => {
    cleanup();
  });

  test("loads the automations sorted by key, with pipeline names", async () => {
    automationsResult = {
      data: [
        buildAutomation({ key: "wayfinder" }),
        buildAutomation({ key: "triage" }),
      ],
      error: null,
    };
    const view = render(<Probe />);
    expect(probeText(view)).toBe("loading");
    await waitFor(() => {
      expect(probeText(view)).toBe(
        "ready:triage,wayfinder|triage=Triage Pipeline|",
      );
    });
  });

  test("builds each step key's grants from its highest active version", async () => {
    automationsResult = { data: [buildAutomation()], error: null };
    stepDefinitionsLoad = () =>
      Promise.resolve({
        data: [
          stepDefinition("plan", 1, "active", [closeSelf]),
          stepDefinition("plan", 2, "active", [createChildren, closeSelf]),
          stepDefinition("plan", 3, "draft", []),
          stepDefinition("research", 1, "archived", [closeSelf]),
        ],
        error: null,
      });
    const view = render(<Probe />);
    await waitFor(() => {
      expect(probeText(view)).toBe(
        "ready:triage|triage=Triage Pipeline|plan:create+close",
      );
    });
  });

  test("a failed step fetch still loads, with no grants", async () => {
    automationsResult = { data: [buildAutomation()], error: null };
    stepDefinitionsLoad = () => Promise.reject(new Error("offline"));
    const view = render(<Probe />);
    await waitFor(() => {
      expect(probeText(view)).toBe("ready:triage|triage=Triage Pipeline|");
    });
  });

  test("reports an error when the automations fail to load", async () => {
    automationsResult = { data: null, error: { status: 500 } };
    const view = render(<Probe />);
    await waitFor(() => {
      expect(probeText(view)).toBe("error:Failed to load automations");
    });
  });

  test("reload loads again", async () => {
    automationsResult = { data: null, error: { status: 500 } };
    const view = render(<Probe />);
    await waitFor(() => {
      expect(probeText(view)).toStartWith("error:");
    });

    automationsResult = { data: [buildAutomation()], error: null };
    act(() => {
      reload();
    });
    await waitFor(() => {
      expect(probeText(view)).toStartWith("ready:triage");
    });
    expect(automationLoads).toBe(2);
  });
});
