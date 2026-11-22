import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { parseUuidV7 } from "@scarn/api/frontend-contracts";
import {
  CONNECTION_ID,
  apiState,
  buildCandidate,
  buildConnection,
  cleanup,
  dialog,
  fireEvent,
  problem,
  renderPanel,
  resetHarness,
  waitFor,
  within,
} from "./project-mcp-connections-panel-test-support";

const STEP_ID = "0198f2c4-0000-7000-8000-000000000003";
const usage = {
  steps: [
    {
      id: STEP_ID,
      key: "notion-review",
      name: "Review Notion",
      pipelines: [{ id: "pipeline", key: "review", name: "Review pipeline" }],
    },
  ],
  liveRuns: 3,
};

describe("managed connection usage impact", () => {
  beforeEach(resetHarness);
  afterEach(cleanup);

  test.each(["disconnect", "reconnect"] as const)(
    "%s shows live impact and a step-library deep link",
    async (mode) => {
      apiState.usageResult = Promise.resolve({ data: usage, error: null });
      const view = renderPanel(
        buildConnection(
          mode === "reconnect"
            ? {
                state: "ready_with_pending_reconnect",
                candidate: buildCandidate(),
              }
            : {},
        ),
      );
      if (mode === "disconnect") {
        fireEvent.click(view.getByRole("button", { name: "Disconnect" }));
      }
      const impact =
        mode === "disconnect"
          ? dialog(view)
          : within(
              view.getByRole("region", { name: "Confirm Notion connection" }),
            );
      expect(
        await impact.findByText(
          "Used by 1 steps. 3 running steps will fail and won't retry.",
        ),
      ).toBeTruthy();
      const href = impact
        .getByRole("link", { name: "Review Notion (notion-review)" })
        .getAttribute("href");
      expect(href).toBe(`/tester/demo/pipelines?stepDefinitionId=${STEP_ID}`);
      expect(impact.getByText(/Review pipeline/)).toBeTruthy();
      expect(apiState.usageCalls).toEqual([CONNECTION_ID]);
    },
  );

  test("loading never implies zero usage", () => {
    apiState.usageResult = new Promise(() => undefined);
    const view = renderPanel(buildConnection());
    fireEvent.click(view.getByRole("button", { name: "Disconnect" }));
    expect(dialog(view).getByText("Loading connection usage…")).toBeTruthy();
    expect(dialog(view).queryByText(/Used by 0/)).toBeNull();
  });

  test("failure hides server details and supports retry", async () => {
    apiState.usageResult = Promise.resolve({
      data: null,
      error: problem(404, "NOT_FOUND", "secret token must never be shown"),
    });
    const view = renderPanel(buildConnection());
    fireEvent.click(view.getByRole("button", { name: "Disconnect" }));
    expect(await dialog(view).findByText(/impact is unknown/)).toBeTruthy();
    expect(view.queryByText(/secret token/)).toBeNull();
    expect(view.queryByText(/Used by 0/)).toBeNull();
    apiState.usageResult = Promise.resolve({ data: usage, error: null });
    fireEvent.click(dialog(view).getByRole("button", { name: "Retry usage" }));
    expect(await dialog(view).findByText(/3 running steps/)).toBeTruthy();
  });

  test("closing and reopening discards an old in-flight response", async () => {
    let resolveOld!: (value: { data: typeof usage; error: null }) => void;
    apiState.usageResult = new Promise((resolve) => {
      resolveOld = resolve;
    });
    const view = renderPanel(buildConnection());
    fireEvent.click(view.getByRole("button", { name: "Disconnect" }));
    fireEvent.click(dialog(view).getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(view.queryByRole("dialog")).toBeNull();
    });
    apiState.usageResult = Promise.resolve({
      data: { steps: [], liveRuns: 7 },
      error: null,
    });
    fireEvent.click(view.getByRole("button", { name: "Disconnect" }));
    expect(await dialog(view).findByText(/7 running steps/)).toBeTruthy();
    resolveOld({ data: usage, error: null });
    await waitFor(() => {
      expect(dialog(view).queryByText(/3 running steps/)).toBeNull();
      expect(dialog(view).getByText(/7 running steps/)).toBeTruthy();
    });
  });

  test("a member without secrets permissions sees no admin impact or requests", () => {
    const view = renderPanel(
      buildConnection({
        state: "ready_with_pending_reconnect",
        candidate: buildCandidate(),
      }),
      { permissions: [] },
    );
    expect(view.getByText(/Only project admins/)).toBeTruthy();
    expect(view.queryByText(/running steps/)).toBeNull();
    expect(apiState.usageCalls).toEqual([]);
  });

  test("reloading a changed connection never reuses the old connection's impact", async () => {
    let resolveOld!: (value: { data: typeof usage; error: null }) => void;
    apiState.usageResult = new Promise((resolve) => {
      resolveOld = resolve;
    });
    const view = renderPanel(
      buildConnection({
        state: "ready_with_pending_reconnect",
        candidate: buildCandidate(),
      }),
    );
    const replacementId = parseUuidV7("0198f2c4-0000-7000-8000-000000000009");
    apiState.confirmResult = {
      data: null,
      error: problem(409, "CONFLICT", "The connection changed."),
    };
    apiState.listResult = {
      data: [
        buildConnection({
          id: replacementId,
          state: "ready_with_pending_reconnect",
          candidate: buildCandidate(),
        }),
      ],
      error: null,
    };
    apiState.usageResult = Promise.resolve({
      data: { steps: [], liveRuns: 8 },
      error: null,
    });
    fireEvent.click(view.getByRole("button", { name: "Confirm" }));
    expect(await view.findByText(/8 running steps/)).toBeTruthy();
    resolveOld({ data: usage, error: null });
    await waitFor(() => {
      expect(view.queryByText(/3 running steps/)).toBeNull();
      expect(view.getByText(/8 running steps/)).toBeTruthy();
      expect(apiState.usageCalls).toEqual([CONNECTION_ID, replacementId]);
    });
  });
});
