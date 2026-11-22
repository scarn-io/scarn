import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ProjectSecretContract } from "@scarn/core/secrets/secret/contracts/project-secret-contracts";
import { parseUuidV7 } from "@scarn/api/frontend-contracts";
import { installDom } from "@/tests/support/install-dom";

/**
 * DOM globals go in before React DOM loads: it decides at import time whether
 * `input` events work, and without them `fireEvent.change` never reaches a
 * controlled field's `onChange`.
 */
installDom();

type ApiResult = { data: unknown; error: unknown };
type UpdateBody = { name?: string; value?: string };

const PROJECT_ID = "01966a2c-9494-7db5-aa46-0f8f5cbbe000";

const apiState = {
  createResult: { data: null, error: null } as ApiResult,
  updateResult: { data: null, error: null } as ApiResult,
  deleteResult: { data: { deleted: true }, error: null } as ApiResult,
  createCalls: [] as {
    projectId: string;
    body: { name: string; value: string };
  }[],
  updateCalls: [] as { secretId: string; body: UpdateBody }[],
  deleteCalls: [] as string[],
};

void mock.module("@/app/_lib/scarn-browser-api-client", () => ({
  getBrowserScarnApiClient: () => ({
    api: {
      projects: ({ projectId }: { projectId: string }) => ({
        secrets: Object.assign(
          ({ secretId }: { secretId: string }) => ({
            patch: (body: UpdateBody) => {
              apiState.updateCalls.push({ secretId, body });
              return Promise.resolve(apiState.updateResult);
            },
            delete: () => {
              apiState.deleteCalls.push(secretId);
              return Promise.resolve(apiState.deleteResult);
            },
          }),
          {
            post: (body: { name: string; value: string }) => {
              apiState.createCalls.push({ projectId, body });
              return Promise.resolve(apiState.createResult);
            },
          },
        ),
      }),
    },
  }),
}));

const { cleanup, fireEvent, render, waitFor, within } =
  await import("@testing-library/react");
const { ProjectSecretsPanel } = await import("./project-secrets-panel");
const { ProjectRouteProvider } =
  await import("@/components/project-route-context");

const SECRET_ID = "0198f2c4-0000-7000-8000-000000000001";

const buildSecret = (
  overrides: Partial<Omit<ProjectSecretContract, "id">> & { id?: string } = {},
): ProjectSecretContract => ({
  projectId: parseUuidV7(PROJECT_ID),
  name: "DATADOG_API_KEY",
  lastFour: "ab12",
  updatedBy: {
    userId: parseUuidV7("0198f2c4-0000-7000-8000-0000000000aa"),
    username: "ada",
  },
  lastUsedAt: null,
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-01T00:00:00.000Z",
  ...overrides,
  id: parseUuidV7(overrides.id ?? SECRET_ID),
});

const problem = (status: number, code: string, detail: string) => ({
  status,
  value: { status, code, detail },
});

const ADMIN = ["secrets:read", "secrets:write"];

const renderPanel = (
  secrets: ProjectSecretContract[],
  permissions: string[] = ADMIN,
) =>
  render(
    <ProjectRouteProvider
      username="tester"
      projectSlug="demo"
      projectId={PROJECT_ID}
      isMember
      permissions={permissions}
    >
      <ProjectSecretsPanel projectId={PROJECT_ID} initialSecrets={secrets} />
    </ProjectRouteProvider>,
  );

const dialog = (view: ReturnType<typeof render>) =>
  within(view.getByRole("dialog"));

const typeInto = (
  view: ReturnType<typeof render>,
  label: string,
  value: string,
) => {
  fireEvent.change(dialog(view).getByLabelText(label), { target: { value } });
};

const WARNING = /will fail to start on any worker that doesn.t set it/;

describe("ProjectSecretsPanel", () => {
  beforeEach(() => {
    apiState.createResult = { data: null, error: null };
    apiState.updateResult = { data: null, error: null };
    apiState.deleteResult = { data: { deleted: true }, error: null };
    apiState.createCalls.length = 0;
    apiState.updateCalls.length = 0;
    apiState.deleteCalls.length = 0;
  });

  afterEach(() => {
    cleanup();
  });

  test("lists name, masked last four, who updated it, and last used", () => {
    const view = renderPanel([
      buildSecret(),
      buildSecret({
        id: "0198f2c4-0000-7000-8000-000000000002",
        name: "SENTRY_TOKEN",
        lastFour: "zz99",
        updatedBy: null,
        lastUsedAt: "2026-10-01T00:00:00.000Z",
      }),
    ]);

    const datadog = within(
      view.getByRole("row", { name: "Secret DATADOG_API_KEY" }),
    );
    expect(datadog.getByText("••••ab12")).toBeTruthy();
    expect(datadog.getByText(/ada,/)).toBeTruthy();
    expect(datadog.getByText("Never")).toBeTruthy();

    const sentry = within(
      view.getByRole("row", { name: "Secret SENTRY_TOKEN" }),
    );
    expect(sentry.getByText("••••zz99")).toBeTruthy();
    expect(sentry.queryByText("Never")).toBeNull();
  });

  test("shows an empty state", () => {
    const view = renderPanel([]);

    expect(view.getByText("No secrets yet.")).toBeTruthy();
  });

  test("is read-only without secrets:write", () => {
    const view = renderPanel([buildSecret()], ["secrets:read"]);

    expect(view.getByText(/Only project admins can/)).toBeTruthy();
    expect(view.queryByRole("button", { name: "Add secret" })).toBeNull();
    expect(
      view.queryByRole("button", { name: "Rename DATADOG_API_KEY" }),
    ).toBeNull();
    expect(
      view.queryByRole("button", { name: "Delete DATADOG_API_KEY" }),
    ).toBeNull();
    expect(
      view.queryByRole("button", { name: "Replace value of DATADOG_API_KEY" }),
    ).toBeNull();
    expect(view.getByText("••••ab12")).toBeTruthy();
  });

  test("adds a secret and lists it first", async () => {
    apiState.createResult = {
      data: buildSecret({
        id: "0198f2c4-0000-7000-8000-000000000003",
        name: "NEW_KEY",
        lastFour: "7890",
      }),
      error: null,
    };
    const view = renderPanel([buildSecret()]);

    fireEvent.click(view.getByRole("button", { name: "Add secret" }));
    const save = dialog(view).getByRole<HTMLButtonElement>("button", {
      name: "Save secret",
    });
    expect(save.disabled).toBe(true);
    typeInto(view, "Name", " NEW_KEY ");
    typeInto(view, "Value", "secret-1234567890");
    fireEvent.click(save);

    await waitFor(() => {
      expect(view.queryByRole("dialog")).toBeNull();
    });
    expect(apiState.createCalls).toEqual([
      {
        projectId: PROJECT_ID,
        body: { name: "NEW_KEY", value: "secret-1234567890" },
      },
    ]);
    const rows = view.getAllByRole("row");
    expect(rows[1]?.getAttribute("aria-label")).toBe("Secret NEW_KEY");
    expect(view.getByText("Saved NEW_KEY.")).toBeTruthy();
  });

  test("keeps the add dialog open with the API message for a taken name", async () => {
    apiState.createResult = {
      data: null,
      error: problem(
        409,
        "SECRET_NAME_TAKEN",
        "This project already has a secret with that name.",
      ),
    };
    const view = renderPanel([buildSecret()]);

    fireEvent.click(view.getByRole("button", { name: "Add secret" }));
    typeInto(view, "Name", "DATADOG_API_KEY");
    typeInto(view, "Value", "secret-value");
    fireEvent.click(dialog(view).getByRole("button", { name: "Save secret" }));

    expect(
      await dialog(view).findByText(
        "This project already has a secret with that name.",
      ),
    ).toBeTruthy();
    expect(dialog(view).getByLabelText<HTMLInputElement>("Value").value).toBe(
      "",
    );
    expect(view.getAllByRole("row", { hidden: true })).toHaveLength(2);
  });

  test("shows the API message for an invalid name", async () => {
    apiState.createResult = {
      data: null,
      error: problem(
        422,
        "SECRET_NAME_INVALID",
        "Project secret name must be uppercase letters, digits and underscores, not starting with a digit",
      ),
    };
    const view = renderPanel([]);

    fireEvent.click(view.getByRole("button", { name: "Add secret" }));
    typeInto(view, "Name", "lower-case");
    typeInto(view, "Value", "secret-value");
    fireEvent.click(dialog(view).getByRole("button", { name: "Save secret" }));

    expect(
      await dialog(view).findByText(/must be uppercase letters, digits/),
    ).toBeTruthy();
  });

  test("replaces a value without renaming", async () => {
    apiState.updateResult = {
      data: buildSecret({ lastFour: "9999" }),
      error: null,
    };
    const view = renderPanel([buildSecret()]);

    fireEvent.click(
      view.getByRole("button", { name: "Replace value of DATADOG_API_KEY" }),
    );
    expect(dialog(view).queryByText(WARNING)).toBeNull();
    typeInto(view, "New value", "new-value-9999");
    fireEvent.click(
      dialog(view).getByRole("button", { name: "Replace value" }),
    );

    await waitFor(() => {
      expect(view.queryByRole("dialog")).toBeNull();
    });
    expect(apiState.updateCalls).toEqual([
      {
        secretId: "0198f2c4-0000-7000-8000-000000000001",
        body: { value: "new-value-9999" },
      },
    ]);
    expect(view.getByText("••••9999")).toBeTruthy();
  });

  test("renames with the startup warning", async () => {
    apiState.updateResult = {
      data: buildSecret({ name: "DD_API_KEY" }),
      error: null,
    };
    const view = renderPanel([buildSecret()]);

    fireEvent.click(
      view.getByRole("button", { name: "Rename DATADOG_API_KEY" }),
    );
    expect(dialog(view).getByText(WARNING)).toBeTruthy();
    const rename = dialog(view).getByRole<HTMLButtonElement>("button", {
      name: "Rename",
    });
    expect(rename.disabled).toBe(true);
    typeInto(view, "Name", "DD_API_KEY");
    fireEvent.click(rename);

    await waitFor(() => {
      expect(view.queryByRole("dialog")).toBeNull();
    });
    expect(apiState.updateCalls).toEqual([
      {
        secretId: "0198f2c4-0000-7000-8000-000000000001",
        body: { name: "DD_API_KEY" },
      },
    ]);
    expect(
      await view.findByRole("row", { name: "Secret DD_API_KEY" }),
    ).toBeTruthy();
    expect(
      view.getByText("Renamed DATADOG_API_KEY to DD_API_KEY."),
    ).toBeTruthy();
  });

  test("a rename to a taken name keeps the dialog open", async () => {
    apiState.updateResult = {
      data: null,
      error: problem(
        409,
        "SECRET_NAME_TAKEN",
        "This project already has a secret with that name.",
      ),
    };
    const view = renderPanel([buildSecret()]);

    fireEvent.click(
      view.getByRole("button", { name: "Rename DATADOG_API_KEY" }),
    );
    typeInto(view, "Name", "OTHER");
    fireEvent.click(dialog(view).getByRole("button", { name: "Rename" }));

    expect(
      await dialog(view).findByText(
        "This project already has a secret with that name.",
      ),
    ).toBeTruthy();
    expect(
      view.getByRole("row", { name: "Secret DATADOG_API_KEY", hidden: true }),
    ).toBeTruthy();
  });

  test("deletes with the startup warning", async () => {
    const view = renderPanel([buildSecret()]);

    fireEvent.click(
      view.getByRole("button", { name: "Delete DATADOG_API_KEY" }),
    );
    expect(dialog(view).getByText(WARNING)).toBeTruthy();
    fireEvent.click(dialog(view).getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(view.queryByRole("dialog")).toBeNull();
    });
    expect(apiState.deleteCalls).toEqual([
      "0198f2c4-0000-7000-8000-000000000001",
    ]);
    expect(view.getByText("No secrets yet.")).toBeTruthy();
  });

  test("a secret already gone (404) leaves the table", async () => {
    apiState.deleteResult = {
      data: null,
      error: problem(404, "SECRET_NOT_FOUND", "Secret not found"),
    };
    const view = renderPanel([buildSecret()]);

    fireEvent.click(
      view.getByRole("button", { name: "Delete DATADOG_API_KEY" }),
    );
    fireEvent.click(dialog(view).getByRole("button", { name: "Delete" }));

    expect(
      await dialog(view).findByText(/That secret no longer exists/),
    ).toBeTruthy();
    expect(view.getByText("No secrets yet.")).toBeTruthy();
  });

  test("maps a 403 to a permission message", async () => {
    apiState.deleteResult = {
      data: null,
      error: problem(403, "FORBIDDEN", "Missing secrets:write"),
    };
    const view = renderPanel([buildSecret()]);

    fireEvent.click(
      view.getByRole("button", { name: "Delete DATADOG_API_KEY" }),
    );
    fireEvent.click(dialog(view).getByRole("button", { name: "Delete" }));

    expect(
      await dialog(view).findByText("You don't have permission to do this."),
    ).toBeTruthy();
  });
});
