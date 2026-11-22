import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import type { UserNotificationContract } from "@scarn/api/frontend-contracts";
import { installDom } from "@/tests/support/install-dom";

const { AutoSyncPausedNotice, readAutoSyncPaused } =
  await import("./auto-sync-paused-notice");
const { NotificationChips } = await import("./notification-internals");
const { ProjectRouteProvider } =
  await import("@/components/project-route-context");

const buildNotification = (
  overrides: Partial<UserNotificationContract> = {},
): UserNotificationContract =>
  ({
    id: "01966a2c-9494-7db5-aa46-0f8f5cbbe101",
    projectId: "01966a2c-9494-7db5-aa46-0f8f5cbbe000",
    kind: "integration_auto_sync_paused",
    priority: "high",
    status: "delivered",
    title: "Auto-sync paused",
    body: "Jira auto-sync paused.",
    source: "system",
    workItemId: null,
    pipelineExecutionId: null,
    payloadJson: {
      integrationId: "01966a2c-9494-7db5-aa46-0f8f5cbbe200",
      reason: "key_rejected",
      detail: "Jira returned 401 Unauthorized.",
    },
    createdAt: "2026-11-01T00:00:00.000Z",
    ...overrides,
  }) as UserNotificationContract;

const renderInProject = (ui: React.ReactNode) =>
  render(
    <ProjectRouteProvider
      username="tester"
      projectSlug="demo"
      projectId="01966a2c-9494-7db5-aa46-0f8f5cbbe000"
      isMember
    >
      {ui}
    </ProjectRouteProvider>,
  );

describe("AutoSyncPausedNotice", () => {
  beforeEach(() => {
    installDom({ url: "https://app.scarn.io/" });
  });

  afterEach(() => {
    cleanup();
  });

  test("shows the reason, the detail and a link to integration settings", () => {
    const view = renderInProject(
      <AutoSyncPausedNotice notification={buildNotification()} />,
    );

    expect(
      view.getByText("Paused: the key it synced with was rejected."),
    ).toBeTruthy();
    expect(view.getByText("Jira returned 401 Unauthorized.")).toBeTruthy();
    expect(
      view
        .getByRole("link", { name: "Integration settings" })
        .getAttribute("href"),
    ).toBe("/tester/demo/settings");
  });

  test("labels the kind chip 'Auto-sync paused'", () => {
    const view = renderInProject(
      <NotificationChips
        notification={buildNotification()}
        hasResponse={false}
      />,
    );

    expect(view.getByText("Auto-sync paused")).toBeTruthy();
  });

  test("a malformed payload still renders a generic paused line", () => {
    const view = renderInProject(
      <AutoSyncPausedNotice
        notification={buildNotification({
          payloadJson: { reason: 42, detail: { nested: true } },
        })}
      />,
    );

    expect(
      view.getByText("Paused: the key it synced with can no longer be used."),
    ).toBeTruthy();
    expect(
      view.getByRole("link", { name: "Integration settings" }),
    ).toBeTruthy();
  });

  test("renders nothing for other notification kinds", () => {
    const view = renderInProject(
      <AutoSyncPausedNotice
        notification={buildNotification({ kind: "status_update" })}
      />,
    );

    expect(view.container.textContent).toBe("");
  });
});

describe("readAutoSyncPaused", () => {
  test("reads reason and detail", () => {
    expect(readAutoSyncPaused(buildNotification())).toEqual({
      reason: "key_rejected",
      detail: "Jira returned 401 Unauthorized.",
    });
  });

  test("tolerates a null payload and unknown reasons", () => {
    expect(
      readAutoSyncPaused(buildNotification({ payloadJson: null })),
    ).toEqual({ reason: null, detail: null });
    expect(
      readAutoSyncPaused(
        buildNotification({
          payloadJson: { reason: "something_new", detail: "  " },
        }),
      ),
    ).toEqual({ reason: null, detail: null });
  });
});
