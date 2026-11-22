/**
 * Cancelling a mixed batch of runs: pipeline runs go in one batch call,
 * Tasks one call each, and the result sorts every id into cancelled,
 * skipped or failed.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { parseUuidV7 } from "@scarn/api/frontend-contracts";
import "@/components/tasks/tasks-test-support";
import type {
  CancelRunsApiClient,
  CancelRunsResult,
} from "./cancel-runs-dialog";

const { cleanup, fireEvent, render, waitFor, within } =
  await import("@testing-library/react");
const { CancelRunsDialog, cancelRuns, cancelRunsSummary } =
  await import("./cancel-runs-dialog");

const id = (suffix: string) =>
  parseUuidV7(`019e9a92-b432-73e8-9341-3519156fb${suffix}`);

type TaskReply = { data: { taskId: string } | null; error: unknown };

const fakeApi = ({
  batch = (input: string[]) => ({
    data: { cancelledIds: input, skippedIds: [] },
    error: null,
  }),
  task = (taskId: string): TaskReply => ({ data: { taskId }, error: null }),
}: {
  batch?: (input: string[]) => {
    data: { cancelledIds: string[]; skippedIds: string[] } | null;
    error: unknown;
  };
  task?: (taskId: string) => TaskReply | Error;
} = {}) => {
  const calls = { batch: [] as string[][], tasks: [] as string[] };
  const api = {
    "pipeline-executions": {
      batch: {
        cancel: {
          put: ({ input }: { input: string[] }) => {
            calls.batch.push(input);
            return Promise.resolve(batch(input));
          },
        },
      },
    },
    tasks: ({ taskId }: { taskId: string }) => ({
      cancel: {
        post: () => {
          calls.tasks.push(taskId);
          const reply = task(taskId);
          return reply instanceof Error
            ? Promise.reject(reply)
            : Promise.resolve(reply);
        },
      },
    }),
  };
  return { apiClient: { api } as unknown as CancelRunsApiClient, calls };
};

const alreadyEnded = {
  status: 422,
  value: { status: 422, code: "TASK_ALREADY_ENDED", detail: "ended" },
};

const page = () => within(document.body);

describe("cancelRuns", () => {
  test("sends pipeline runs in one batch and Tasks one by one", async () => {
    const { apiClient, calls } = fakeApi({
      batch: (input) => ({
        data: { cancelledIds: [input[0] as string], skippedIds: [id("502")] },
        error: null,
      }),
      task: (taskId) =>
        taskId === id("602")
          ? { data: null, error: alreadyEnded }
          : { data: { taskId }, error: null },
    });

    const result = await cancelRuns(apiClient, [
      { type: "pipeline", id: id("501") },
      { type: "step", id: id("601") },
      { type: "pipeline", id: id("502") },
      { type: "task", id: id("602") },
    ]);

    expect(calls.batch).toEqual([[id("501"), id("502")]]);
    expect(calls.tasks.sort()).toEqual([id("601"), id("602")]);
    expect(result.cancelledIds.sort()).toEqual([id("501"), id("601")]);
    expect(result.skippedIds.sort()).toEqual([id("502"), id("602")]);
    expect(result.failedIds).toEqual([]);
    expect(result.error).toBeNull();
  });

  test("skips the batch call when only Tasks are selected", async () => {
    const { apiClient, calls } = fakeApi();
    await cancelRuns(apiClient, [{ type: "task", id: id("601") }]);
    expect(calls.batch).toEqual([]);
    expect(calls.tasks).toEqual([id("601")]);
  });

  test("counts failed requests separately", async () => {
    const { apiClient } = fakeApi({
      batch: () => ({
        data: null,
        error: { status: 403, value: { status: 403 } },
      }),
      task: () => new Error("network down"),
    });
    const result = await cancelRuns(apiClient, [
      { type: "pipeline", id: id("501") },
      { type: "task", id: id("601") },
    ]);
    expect(result.cancelledIds).toEqual([]);
    expect(result.failedIds.sort()).toEqual([id("501"), id("601")]);
    expect(result.error).not.toBeNull();
  });
});

describe("cancelRunsSummary", () => {
  test("names what was cancelled, skipped and failed", () => {
    expect(
      cancelRunsSummary({
        cancelledIds: ["a", "b"],
        skippedIds: ["c"],
        failedIds: ["d", "e"],
      }),
    ).toBe(
      "Cancelled 2 runs. 1 run was no longer in progress and was skipped. 2 runs could not be cancelled.",
    );
    expect(
      cancelRunsSummary({ cancelledIds: ["a"], skippedIds: [], failedIds: [] }),
    ).toBe("Cancelled 1 run.");
  });
});

describe("CancelRunsDialog", () => {
  afterEach(() => {
    cleanup();
  });

  test("dismisses without cancelling, and reports the result on confirm", async () => {
    const { apiClient, calls } = fakeApi();
    const closed: true[] = [];
    const results: CancelRunsResult[] = [];
    render(
      <CancelRunsDialog
        open
        runs={[
          { type: "pipeline", id: id("501") },
          { type: "step", id: id("601") },
        ]}
        apiClient={apiClient}
        onClose={() => closed.push(true)}
        onCancelled={(result) => results.push(result)}
      />,
    );
    expect(page().getByText("Cancel 2 runs?")).toBeTruthy();

    fireEvent.click(page().getByRole("button", { name: "Cancel" }));
    expect(closed).toEqual([true]);
    expect(calls.batch).toEqual([]);

    fireEvent.click(page().getByRole("button", { name: "Cancel runs" }));
    await waitFor(() => {
      expect(results).toHaveLength(1);
    });
    expect(results[0]?.cancelledIds.sort()).toEqual([id("501"), id("601")]);
  });

  test("stays open with the error when nothing could be cancelled", async () => {
    const { apiClient } = fakeApi({
      batch: () => ({
        data: null,
        error: { status: 403, value: { status: 403 } },
      }),
    });
    const results: CancelRunsResult[] = [];
    render(
      <CancelRunsDialog
        open
        runs={[{ type: "pipeline", id: id("501") }]}
        apiClient={apiClient}
        onClose={() => {}}
        onCancelled={(result) => results.push(result)}
      />,
    );
    fireEvent.click(page().getByRole("button", { name: "Cancel runs" }));
    await waitFor(() => {
      expect(
        page().getByText("You don't have permission to do this."),
      ).toBeTruthy();
    });
    expect(results).toEqual([]);
  });
});
