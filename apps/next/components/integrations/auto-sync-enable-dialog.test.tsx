import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { installAutoSyncTestEnvironment } from "./integration-auto-sync-api-mock";
import {
  GITHUB_KEY_ID,
  JIRA_KEY_ID,
  PROJECT_ID,
  githubIntegration,
  jiraIntegration,
} from "./integration-auto-sync-test-support";
import type { AutoSyncSectionIntegration } from "./integration-auto-sync-section";

const api = installAutoSyncTestEnvironment();

const { cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { AutoSyncEnableDialog } = await import("./auto-sync-enable-dialog");

const JIRA_CONSENT =
  "Scarn will read issues from ACME, WEB using your Jira account every 5 minutes. Everyone in this project will see the issues your account can see. Your key is only used for syncing and is never shown to others.";
const GITHUB_CONSENT =
  "Scarn will read issues from acme/api and acme/web using your GitHub token every 5 minutes. Everyone in this project will see those issues, even if they can't see the repos on GitHub. Syncing uses part of your token's GitHub rate limit. Your token is only used for syncing and is never shown to others.";
const APP_HINT =
  "Installing the GitHub App is better if you can: it syncs instantly and doesn't use your rate limit.";

const renderDialog = (
  integration: AutoSyncSectionIntegration,
  { githubAppConfigured = true, onEnabled = mock(() => {}) } = {},
) =>
  render(
    <AutoSyncEnableDialog
      open
      projectId={PROJECT_ID}
      integration={integration}
      githubAppConfigured={githubAppConfigured}
      onClose={() => {}}
      onEnabled={onEnabled}
    />,
  );

const radioNames = (view: ReturnType<typeof render>) =>
  view
    .getAllByRole("radio")
    .map((radio) => radio.closest("label")?.textContent ?? "");

describe("AutoSyncEnableDialog", () => {
  beforeEach(() => {
    api.reset();
  });

  afterEach(() => {
    cleanup();
  });

  test.each([true, false])(
    "Jira consent text never has the App hint (App configured: %p)",
    (githubAppConfigured) => {
      const view = renderDialog(jiraIntegration(), { githubAppConfigured });
      expect(view.getByText(JIRA_CONSENT)).toBeTruthy();
      expect(view.queryByText(APP_HINT)).toBeNull();
    },
  );

  test("GitHub consent text adds the App hint when the App is configured", () => {
    const view = renderDialog(githubIntegration());
    expect(view.getByText(GITHUB_CONSENT)).toBeTruthy();
    expect(view.getByText(APP_HINT)).toBeTruthy();
  });

  test("GitHub consent text leaves out the App hint when no App is configured", () => {
    const view = renderDialog(githubIntegration(), {
      githubAppConfigured: false,
    });
    expect(view.getByText(GITHUB_CONSENT)).toBeTruthy();
    expect(view.queryByText(APP_HINT)).toBeNull();
  });

  test("Jira lists only Jira API keys, plus adding one", async () => {
    const view = renderDialog(jiraIntegration());
    await waitFor(() => {
      expect(view.getAllByRole("radio")).toHaveLength(2);
    });
    const names = radioNames(view);
    expect(names[0]).toContain("Work Jira");
    expect(names[1]).toBe("Add a Jira API key");
  });

  test("GitHub lists only GitHub tokens, plus adding one", async () => {
    const view = renderDialog(githubIntegration());
    await waitFor(() => {
      expect(view.getAllByRole("radio")).toHaveLength(2);
    });
    const names = radioNames(view);
    expect(names[0]).toContain("Work GitHub");
    expect(names[1]).toBe("Add a GitHub token");
  });

  test.each([
    ["Jira", jiraIntegration, JIRA_KEY_ID],
    ["GitHub", githubIntegration, GITHUB_KEY_ID],
  ] as const)(
    "%s: lending the picked key sends PUT { secretId }",
    async (_label, build, keyId) => {
      const updated = { id: "updated" };
      api.putResult = { data: updated, error: null };
      const onEnabled = mock(() => {});
      const integration = build();
      const view = renderDialog(integration, { onEnabled });
      await waitFor(() => {
        expect(view.getAllByRole("radio")).toHaveLength(2);
      });

      fireEvent.click(view.getByRole("button", { name: "Turn on auto-sync" }));

      await waitFor(() => {
        expect(onEnabled).toHaveBeenCalledWith(updated);
      });
      expect(api.putCalls).toEqual([
        { integrationId: integration.id, body: { secretId: keyId } },
      ]);
    },
  );

  test("with no saved keys it shows the add-key form and can't be turned on yet", async () => {
    api.listResult = { data: [], error: null };
    const view = renderDialog(jiraIntegration());

    await waitFor(() => {
      expect(view.getByRole("form", { name: "Add Jira API key" })).toBeTruthy();
    });
    const turnOn = view.getByRole("button", {
      name: "Turn on auto-sync",
    }) as HTMLButtonElement;
    expect(turnOn.disabled).toBe(true);
  });

  test("a rejected key shows the API's message", async () => {
    api.putResult = {
      data: null,
      error: {
        status: 422,
        value: { status: 422, detail: "Can't reach acme/web with this token." },
      },
    };
    const view = renderDialog(githubIntegration());
    await waitFor(() => {
      expect(view.getAllByRole("radio")).toHaveLength(2);
    });

    fireEvent.click(view.getByRole("button", { name: "Turn on auto-sync" }));

    expect(
      await view.findByText("Can't reach acme/web with this token."),
    ).toBeTruthy();
  });
});
