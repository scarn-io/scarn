import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  api,
  projectId,
  resetApi,
  withProjectRoute,
  workItemId,
} from "./tasks-test-support";

const { cleanup, fireEvent, render, waitFor, within } =
  await import("@testing-library/react");

const { StartTaskButton } = await import("./start-task-dialog");

const stepDefinitionId = "019e9a92-b432-73e8-9341-3519156fa600";
const createdTaskHref =
  "/alice/demo/runs/tasks/019e9a92-b432-73e8-9341-3519156fa9ff";

const field = (dialog: HTMLElement, label: string): HTMLElement => {
  const labelElement = within(dialog).getByText(label, { selector: "label" });
  const control = document.getElementById(
    labelElement.getAttribute("for") ?? "",
  );
  if (!control) throw new Error(`No control for ${label}`);
  return control;
};

const openOptions = async (dialog: HTMLElement, label: string) => {
  const control = field(dialog, label);
  fireEvent.mouseDown(control);
  const listbox = await within(document.body).findByRole("listbox");
  return { control, listbox };
};

/** Clicks a multi-select menu's backdrop: Escape would also close the dialog. */
const closeOptions = async ({
  control,
  listbox,
}: {
  control: HTMLElement;
  listbox: HTMLElement;
}) => {
  if (control.getAttribute("aria-expanded") === "true") {
    const backdrop = listbox
      .closest(".MuiPopover-root")
      ?.querySelector(".MuiBackdrop-root");
    if (backdrop) fireEvent.click(backdrop);
  }
  await waitFor(() => {
    expect(control.getAttribute("aria-expanded")).toBe("false");
  });
};

const option = (listbox: HTMLElement, text: string): HTMLElement => {
  const found = within(listbox).getByText(text).closest('[role="option"]');
  if (!(found instanceof HTMLElement)) throw new Error(`No option ${text}`);
  return found;
};

const choose = async (dialog: HTMLElement, label: string, text: string) => {
  const menu = await openOptions(dialog, label);
  fireEvent.click(await waitFor(() => option(menu.listbox, text)));
  await closeOptions(menu);
};

const openDialog = async () => {
  const view = await renderButton();
  fireEvent.click(view.getByRole("button", { name: "Start task" }));
  return await within(document.body).findByRole("dialog");
};

const openPromptDialog = async () => {
  const dialog = await openDialog();
  fireEvent.click(within(dialog).getByRole("button", { name: "Prompt" }));
  fireEvent.change(within(dialog).getByLabelText("Prompt"), {
    target: { value: "Reproduce the bug" },
  });
  return dialog;
};

const startButton = (dialog: HTMLElement) =>
  within(dialog).getByRole("button", { name: "Start" });

const datadog = {
  id: "datadog",
  name: "Datadog",
  description: "Metrics",
  auth: "none" as const,
  requiredVars: [
    { name: "DD_API_KEY", description: "API key" },
    { name: "DD_APP_KEY", description: "App key" },
  ],
};

const renderButton = async (permissions = ["executions:write"]) =>
  render(
    await withProjectRoute(
      <StartTaskButton projectId={projectId} workItemId={workItemId} />,
      permissions,
    ),
  );

describe("StartTaskButton", () => {
  beforeEach(() => {
    resetApi();
  });

  afterEach(() => {
    cleanup();
  });

  test("is hidden without executions:write", async () => {
    const view = await renderButton([]);
    expect(view.queryByRole("button", { name: "Start task" })).toBeNull();
  });

  test("starts a Task from the latest version of a step definition", async () => {
    api.stepDefinitions.push(
      { id: stepDefinitionId, key: "implement", name: "Implement", version: 2 },
      { id: stepDefinitionId, key: "implement", name: "Implement", version: 4 },
    );
    const view = await renderButton();

    fireEvent.click(view.getByRole("button", { name: "Start task" }));
    const dialog = await within(document.body).findByRole("dialog");
    expect(
      within(dialog).queryByRole("switch", { name: "Allow commits" }),
    ).toBeNull();
    await choose(dialog, "Step definition", "Implement (implement v4)");
    fireEvent.click(within(dialog).getByRole("button", { name: "Start" }));

    await waitFor(() => {
      expect(api.pushes).toEqual([createdTaskHref]);
    });
    expect(api.postBodies).toEqual([
      {
        projectId,
        workItemId,
        stepDefinitionId,
        stepDefinitionVersion: 4,
      },
    ]);
  });

  test("switches to a prompt box with Start disabled until it has text", async () => {
    const view = await renderButton();

    fireEvent.click(view.getByRole("button", { name: "Start task" }));
    const dialog = await within(document.body).findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Prompt" }));

    expect(within(dialog).getByLabelText("Prompt")).toBeTruthy();
    expect(
      within(dialog)
        .getByRole("button", { name: "Start" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });
});

describe("StartTaskDialog environment and connectors", () => {
  beforeEach(() => {
    resetApi();
    api.environments = {
      base: { connectors: ["github"] },
      staging: {
        connectors: ["sentry"],
        vars: [{ name: "DD_API_KEY", source: "secret", secret: "DD_STAGING" }],
      },
    };
    api.connectors.push(
      datadog,
      { ...datadog, id: "github", name: "GitHub", requiredVars: [] },
      { ...datadog, id: "sentry", name: "Sentry", requiredVars: [] },
    );
  });

  afterEach(() => {
    cleanup();
  });

  test("defaults to the repo default and sends no environment", async () => {
    const dialog = await openPromptDialog();

    expect(field(dialog, "Environment").textContent).toBe("Repo default");
    fireEvent.click(startButton(dialog));

    await waitFor(() => {
      expect(api.postBodies).toEqual([
        {
          projectId,
          workItemId,
          prompt: "Reproduce the bug",
          repoWrite: false,
        },
      ]);
    });
  });

  test("sends repoWrite once Allow commits is on", async () => {
    const dialog = await openPromptDialog();

    const toggle = within(dialog).getByRole("switch", {
      name: "Allow commits",
    });
    expect((toggle as HTMLInputElement).checked).toBe(false);
    expect(dialog.textContent).toContain(
      "The agent can push a new scarn/… branch.",
    );
    fireEvent.click(toggle);
    fireEvent.click(startButton(dialog));

    await waitFor(() => {
      expect(api.postBodies).toEqual([
        { projectId, workItemId, prompt: "Reproduce the bug", repoWrite: true },
      ]);
    });
  });

  test("sends a chosen override and locks its connectors", async () => {
    const dialog = await openPromptDialog();

    await choose(dialog, "Environment", "staging");
    const menu = await openOptions(dialog, "Connectors");
    const { listbox } = menu;
    await waitFor(() => {
      expect(option(listbox, "Sentry").getAttribute("aria-disabled")).toBe(
        "true",
      );
    });
    expect(
      within(listbox).getByText('From environment "staging"'),
    ).toBeTruthy();
    await closeOptions(menu);
    fireEvent.click(startButton(dialog));

    await waitFor(() => {
      expect(api.postBodies).toEqual([
        {
          projectId,
          workItemId,
          prompt: "Reproduce the bug",
          repoWrite: false,
          environment: { name: "staging" },
        },
      ]);
    });
  });

  test("labels the default Step default and locks the step's named environment connectors", async () => {
    api.stepDefinitions.push({
      id: stepDefinitionId,
      key: "implement",
      name: "Implement",
      version: 1,
      environment: { kind: "named", name: "base" },
      opencodeMcpJson: { linear: { type: "remote", url: "https://x" } },
    });
    const dialog = await openDialog();
    await choose(dialog, "Step definition", "Implement (implement v1)");

    expect(field(dialog, "Environment").textContent).toBe("Step default");
    await waitFor(() => {
      expect(field(dialog, "Connectors").textContent).toBe("GitHub, linear");
    });
  });

  test("disables the Environment select for an inline step environment", async () => {
    api.stepDefinitions.push({
      id: stepDefinitionId,
      key: "implement",
      name: "Implement",
      version: 1,
      environment: { kind: "inline", connectors: ["github"] },
      opencodeMcpJson: null,
    });
    const dialog = await openDialog();
    await choose(dialog, "Step definition", "Implement (implement v1)");

    expect(field(dialog, "Environment").getAttribute("aria-disabled")).toBe(
      "true",
    );
    expect(
      within(dialog).getByText(
        "This step defines its own environment, so it can't be replaced.",
      ),
    ).toBeTruthy();
  });

  test("pre-fills an extra's var with the saved secret of the same name", async () => {
    api.secretNames.push("DD_API_KEY", "DD_APP_KEY");
    const dialog = await openPromptDialog();
    await waitFor(() => {
      expect(api.connectors.length).toBeGreaterThan(0);
    });
    await choose(dialog, "Connectors", "Datadog");

    await waitFor(() => {
      expect(
        within(dialog)
          .getByLabelText("Datadog: DD_API_KEY")
          .getAttribute("value"),
      ).toBe("DD_API_KEY");
    });
    fireEvent.click(startButton(dialog));

    await waitFor(() => {
      expect(api.postBodies[0]?.["environment"]).toEqual({
        extraConnectors: [
          {
            connectorId: "datadog",
            vars: {
              DD_API_KEY: { secret: "DD_API_KEY" },
              DD_APP_KEY: { secret: "DD_APP_KEY" },
            },
          },
        ],
      });
    });
  });

  test("accepts a typed secret name as required from the worker, and skips vars the environment provides", async () => {
    const dialog = await openPromptDialog();
    await choose(dialog, "Environment", "staging");
    await choose(dialog, "Connectors", "Datadog");

    expect(within(dialog).queryByLabelText("Datadog: DD_API_KEY")).toBeNull();
    const field = within(dialog).getByLabelText("Datadog: DD_APP_KEY");
    fireEvent.change(field, { target: { value: "DD_STAGING_APP" } });
    expect(
      within(dialog).getByText("Not saved in Scarn: required from worker."),
    ).toBeTruthy();
    fireEvent.click(startButton(dialog));

    await waitFor(() => {
      expect(api.postBodies[0]?.["environment"]).toEqual({
        name: "staging",
        extraConnectors: [
          {
            connectorId: "datadog",
            vars: { DD_APP_KEY: { secret: "DD_STAGING_APP" } },
          },
        ],
      });
    });
  });

  test("keeps Start disabled while an extra's var has no secret name", async () => {
    const dialog = await openPromptDialog();
    await choose(dialog, "Connectors", "Datadog");

    expect(within(dialog).getAllByText("Name a project secret.")).toHaveLength(
      2,
    );
    expect(startButton(dialog).hasAttribute("disabled")).toBe(true);
  });

  test("shows a 422 on the field it's about", async () => {
    api.createTaskError = {
      status: 422,
      code: "ENVIRONMENT_OVERRIDE_INCOMPATIBLE",
      detail: 'Environment "staging" doesn\'t fit this step',
      meta: { name: "staging", reason: "connector_mcp_collision" },
    };
    const dialog = await openPromptDialog();
    await choose(dialog, "Environment", "staging");
    fireEvent.click(startButton(dialog));

    expect(
      await within(dialog).findByText(
        'Environment "staging" doesn\'t fit this step',
      ),
    ).toBeTruthy();
    expect(within(dialog).queryByRole("alert")).toBeNull();
  });

  test("shows a missing-var 422 under that var", async () => {
    api.secretNames.push("DD_API_KEY", "DD_APP_KEY");
    api.createTaskError = {
      status: 422,
      code: "CONNECTOR_VAR_MISSING",
      detail: "needs DD_APP_KEY",
      meta: { connectorId: "datadog", vars: ["DD_APP_KEY"] },
    };
    const dialog = await openPromptDialog();
    await choose(dialog, "Connectors", "Datadog");
    await waitFor(() => {
      expect(startButton(dialog).hasAttribute("disabled")).toBe(false);
    });
    fireEvent.click(startButton(dialog));

    expect(
      await within(dialog).findByText("Name a project secret for this var."),
    ).toBeTruthy();
  });
});
