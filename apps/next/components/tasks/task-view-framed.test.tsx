/** In a run's frame, the Task view leaves its header to the frame. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  api,
  buildTask,
  projectId,
  resetApi,
  withProjectRoute,
} from "./tasks-test-support";

const { act, cleanup, render, waitFor } =
  await import("@testing-library/react");
const { TaskView } = await import("./task-view");

describe("TaskView in a run's frame", () => {
  beforeEach(() => {
    resetApi();
    api.taskDetail = {
      ...buildTask({ status: "succeeded" }),
      errorJson: null,
      resultJson: null,
    };
  });

  afterEach(() => {
    cleanup();
  });

  test("drops the breadcrumb and header, keeps Transcript and Logs", async () => {
    const view = await act(async () =>
      render(
        await withProjectRoute(
          <TaskView
            taskId="019e9a92-b432-73e8-9341-3519156fa801"
            projectId={projectId}
            framed
          />,
        ),
      ),
    );

    await waitFor(() => {
      expect(view.getByRole("tab", { name: "Transcript" })).toBeTruthy();
    });
    expect(view.getByRole("tab", { name: "Logs" })).toBeTruthy();
    expect(view.queryByRole("navigation", { name: "Breadcrumb" })).toBeNull();
    expect(view.queryByRole("heading", { name: "Implement" })).toBeNull();
    expect(view.queryByTestId("task-caption")).toBeNull();
  });
});
