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

const datadog = {
  id: "datadog",
  name: "Datadog",
  description: "Metrics",
  auth: "none" as const,
  requiredVars: [{ name: "DD_API_KEY", description: "API key" }],
};

const START_DIALOG = "Start a task";

const startDialog = () =>
  within(document.body)
    .getAllByRole("dialog")
    .find((dialog) => dialog.textContent.includes(START_DIALOG)) as HTMLElement;

const addSecretDialog = () =>
  within(document.body).findByRole("form", { name: "Add secret" });

const openWithDatadog = async (permissions: string[]) => {
  const view = render(
    await withProjectRoute(
      <StartTaskButton projectId={projectId} workItemId={workItemId} />,
      permissions,
    ),
  );
  fireEvent.click(view.getByRole("button", { name: "Start task" }));
  const dialog = await within(document.body).findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Prompt" }));
  fireEvent.change(within(dialog).getByLabelText("Prompt"), {
    target: { value: "Reproduce the bug" },
  });
  const label = await waitFor(() =>
    within(dialog).getByText("Connectors", { selector: "label" }),
  );
  const control = document.getElementById(label.getAttribute("for") ?? "");
  if (!control) throw new Error("No Connectors control");
  fireEvent.mouseDown(control);
  const listbox = await within(document.body).findByRole("listbox");
  fireEvent.click(await waitFor(() => within(listbox).getByText("Datadog")));
  const backdrop = listbox
    .closest(".MuiPopover-root")
    ?.querySelector(".MuiBackdrop-root");
  if (backdrop) fireEvent.click(backdrop);
  await waitFor(() => {
    expect(control.getAttribute("aria-expanded")).toBe("false");
  });
  return dialog;
};

const addButton = (dialog: HTMLElement) =>
  within(dialog).queryByRole("button", {
    name: "Add secret for Datadog: DD_API_KEY",
  });

describe("StartTaskDialog adding a project secret", () => {
  beforeEach(() => {
    resetApi();
    api.connectors.push(datadog);
  });

  afterEach(() => {
    cleanup();
  });

  test("saves a new secret named after the var and uses it", async () => {
    const dialog = await openWithDatadog(["executions:write", "secrets:write"]);

    const button = addButton(dialog);
    expect(button).not.toBeNull();
    fireEvent.click(button as HTMLElement);
    const form = await addSecretDialog();
    expect(within(form).getByLabelText("Name").getAttribute("value")).toBe(
      "DD_API_KEY",
    );
    fireEvent.change(within(form).getByLabelText("Value"), {
      target: { value: "dd-secret-1234" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Save secret" }));

    await waitFor(() => {
      expect(
        within(document.body).queryByRole("form", { name: "Add secret" }),
      ).toBeNull();
    });
    expect(api.secretPosts).toEqual([
      { name: "DD_API_KEY", value: "dd-secret-1234" },
    ]);
    const start = startDialog();
    expect(
      within(start).getByLabelText("Datadog: DD_API_KEY").getAttribute("value"),
    ).toBe("DD_API_KEY");
    expect(within(start).getByText("Saved project secret.")).toBeTruthy();
    expect(addButton(start)).toBeNull();

    fireEvent.click(within(start).getByRole("button", { name: "Start" }));
    await waitFor(() => {
      expect(api.postBodies[0]?.["environment"]).toEqual({
        extraConnectors: [
          {
            connectorId: "datadog",
            vars: { DD_API_KEY: { secret: "DD_API_KEY" } },
          },
        ],
      });
    });
  });

  test("pre-fills a typed name that isn't saved yet", async () => {
    const dialog = await openWithDatadog(["executions:write", "secrets:write"]);
    fireEvent.change(within(dialog).getByLabelText("Datadog: DD_API_KEY"), {
      target: { value: "DD_STAGING_KEY" },
    });

    fireEvent.click(addButton(dialog) as HTMLElement);
    const form = await addSecretDialog();

    expect(within(form).getByLabelText("Name").getAttribute("value")).toBe(
      "DD_STAGING_KEY",
    );
  });

  test("keeps the add dialog open with the server's message on failure", async () => {
    api.createSecretError = {
      status: 422,
      code: "VALIDATION_ERROR",
      detail: "A secret named DD_API_KEY already exists.",
    };
    const dialog = await openWithDatadog(["executions:write", "secrets:write"]);

    fireEvent.click(addButton(dialog) as HTMLElement);
    const form = await addSecretDialog();
    fireEvent.change(within(form).getByLabelText("Value"), {
      target: { value: "dd-secret-1234" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Save secret" }));

    expect(
      await within(form).findByText(
        "A secret named DD_API_KEY already exists.",
      ),
    ).toBeTruthy();
  });

  test("offers no Add secret button without secrets:write", async () => {
    const dialog = await openWithDatadog(["executions:write"]);

    expect(within(dialog).getByLabelText("Datadog: DD_API_KEY")).toBeTruthy();
    expect(addButton(dialog)).toBeNull();
  });
});
