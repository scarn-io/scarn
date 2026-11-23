/** A scheduled Task's header names its schedule and links its history. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { parseUuidV7 } from "@scarn/api/frontend-contracts";
import type { TaskSummary } from "./task-api";
import {
  api,
  buildTask,
  projectId,
  resetApi,
  withProjectRoute,
} from "./tasks-test-support";

const { act, cleanup, render } = await import("@testing-library/react");
const { TaskView } = await import("./task-view");

const scheduleId = parseUuidV7("019e9a92-b432-73e8-9341-3519156fa920");

const scheduledBy = (
  user: { userId: string; username: string } | null,
): TaskSummary["startedBy"] => ({
  kind: "schedule",
  automationId: parseUuidV7("019e9a92-b432-73e8-9341-3519156fa921"),
  key: "poller",
  title: "Poller",
  schedule: { id: scheduleId, key: "hourly", removed: true },
  user: user && { ...user, userId: parseUuidV7(user.userId) },
});

const renderScheduled = async (startedBy: TaskSummary["startedBy"]) => {
  api.taskDetail = {
    ...buildTask({
      name: null,
      workItem: null,
      scheduledFor: "2026-11-01T12:00:00.000Z",
      startedBy,
    }),
    errorJson: null,
    resultJson: null,
  };
  return await act(async () =>
    render(
      await withProjectRoute(
        <TaskView
          taskId="019e9a92-b432-73e8-9341-3519156fa801"
          projectId={projectId}
        />,
      ),
    ),
  );
};

describe("TaskView for a scheduled Task", () => {
  beforeEach(() => {
    resetApi();
  });

  afterEach(() => {
    cleanup();
  });

  test("is named by its schedule and links its history", async () => {
    const view = await renderScheduled(scheduledBy(null));

    await view.findByRole("heading", { name: "Poller · hourly" });
    const schedule = view.getByTestId("task-schedule");
    expect(schedule.textContent).toStartWith(
      "Scheduled · Poller / hourly (removed) for ",
    );
    expect(schedule.querySelector("time")?.getAttribute("dateTime")).toBe(
      "2026-11-01T12:00:00.000Z",
    );
    expect(
      view
        .getByRole("link", { name: "Scheduled · Poller / hourly" })
        .getAttribute("href"),
    ).toBe(`/alice/demo/runs?status=all&schedule=${scheduleId}`);
    expect(view.getByTestId("task-caption").textContent).toContain(
      "Started on schedule",
    );
  });

  test("names who used Run now", async () => {
    const view = await renderScheduled(
      scheduledBy({
        userId: "019e9a92-b432-73e8-9341-3519156fa922",
        username: "bob",
      }),
    );

    await view.findByRole("heading", { name: "Poller · hourly" });
    expect(view.getByTestId("task-caption").textContent).toContain(
      "Run now by bob",
    );
  });
});
