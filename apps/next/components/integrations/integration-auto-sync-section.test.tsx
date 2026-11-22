import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { installAutoSyncTestEnvironment } from "./integration-auto-sync-api-mock";
import {
  PROJECT_ID,
  autoSyncOff,
  autoSyncOn,
  autoSyncPaused,
  githubIntegration,
  jiraIntegration,
} from "./integration-auto-sync-test-support";
import type { AutoSyncSectionIntegration } from "./integration-auto-sync-section";

const api = installAutoSyncTestEnvironment();

const { cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { IntegrationAutoSyncSection } =
  await import("./integration-auto-sync-section");

const renderSection = (
  integration: AutoSyncSectionIntegration,
  { canManage = true, onIntegrationChange = mock(() => {}) } = {},
) =>
  render(
    <IntegrationAutoSyncSection
      projectId={PROJECT_ID}
      integration={integration}
      githubAppConfigured
      canManage={canManage}
      onIntegrationChange={onIntegrationChange}
    />,
  );

const platforms = [
  ["Jira", jiraIntegration],
  ["GitHub", githubIntegration],
] as const;

describe("IntegrationAutoSyncSection", () => {
  beforeEach(() => {
    api.reset();
  });

  afterEach(() => {
    cleanup();
  });

  describe.each(platforms)("%s", (_label, build) => {
    test("renders nothing when auto-sync isn't supported", () => {
      const view = renderSection(build({ ...autoSyncOff, supported: false }));
      expect(view.container.innerHTML).toBe("");
    });

    test("off: offers to turn it on", () => {
      const view = renderSection(build(autoSyncOff));
      expect(view.getByText("Auto-sync off")).toBeTruthy();
      expect(
        view.getByRole("button", { name: "Turn on auto-sync" }),
      ).toBeTruthy();
    });

    test("on: shows who it syncs as and lets you take over or turn off", () => {
      const view = renderSection(build(autoSyncOn));
      expect(
        view.getByText(
          "Auto-sync on · as Alice (Work key) · last synced 2 minutes ago",
        ),
      ).toBeTruthy();
      expect(
        view.getByRole("button", { name: "Use my key instead" }),
      ).toBeTruthy();
      expect(
        view.getByRole("button", { name: "Turn off auto-sync" }),
      ).toBeTruthy();
    });

    test.each([
      ["key_removed", "Paused: the key it synced with was removed."],
      ["key_rejected", "Paused: the key it synced with was rejected."],
      ["key_expired", "Paused: the key it synced with expired."],
      ["owner_left_project", "Paused: the key's owner left this project."],
      ["access_lost", "Paused: the key it synced with lost access."],
    ] as const)("paused (%s): says why and offers your key", (reason, line) => {
      const view = renderSection(build(autoSyncPaused(reason)));
      expect(
        view.getByText(`${line} Turn it back on with your key.`),
      ).toBeTruthy();
      expect(
        view.getByRole("button", { name: "Turn back on with my key" }),
      ).toBeTruthy();
    });

    test("paused: shows the detail", () => {
      const view = renderSection(
        build(autoSyncPaused("access_lost", "acme/api is no longer reachable")),
      );
      expect(view.getByText("acme/api is no longer reachable")).toBeTruthy();
    });

    test.each([
      ["off", autoSyncOff, "Auto-sync off"],
      [
        "on",
        autoSyncOn,
        "Auto-sync on · as Alice (Work key) · last synced 2 minutes ago",
      ],
      [
        "paused",
        autoSyncPaused("key_removed"),
        "Paused: the key it synced with was removed.",
      ],
    ] as const)(
      "read-only member (%s): status without controls",
      (_state, autoSync, line) => {
        const view = renderSection(build(autoSync), { canManage: false });
        expect(view.getByText(line)).toBeTruthy();
        expect(view.queryByRole("button")).toBeNull();
      },
    );
  });

  test("turning off sends DELETE and hands back the updated integration", async () => {
    const updated = { id: "updated" };
    api.deleteResult = { data: updated, error: null };
    const onIntegrationChange = mock(() => {});
    const integration = jiraIntegration(autoSyncOn);
    const view = renderSection(integration, { onIntegrationChange });

    fireEvent.click(view.getByRole("button", { name: "Turn off auto-sync" }));

    await waitFor(() => {
      expect(onIntegrationChange).toHaveBeenCalledWith(updated);
    });
    expect(api.deleteCalls).toEqual([integration.id]);
  });

  test("a failed turn-off shows the error", async () => {
    api.deleteResult = {
      data: null,
      error: { value: { message: "Nope" } },
    };
    const view = renderSection(jiraIntegration(autoSyncOn));

    fireEvent.click(view.getByRole("button", { name: "Turn off auto-sync" }));

    await waitFor(() => {
      expect(view.getByRole("alert")).toBeTruthy();
    });
  });
});
