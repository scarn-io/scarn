import { describe, expect } from "bun:test";
import { concurrentTest, unwrapAsync } from "tests/utils";
import {
  fromStep,
  useEnvironmentSelectionProject,
} from "./task-environment-selection-test-support";

const datadog = {
  connectorId: "datadog",
  vars: {
    DD_API_KEY: { secret: "DATADOG_STAGING_KEY" },
    DD_APPLICATION_KEY: { secret: "DATADOG_STAGING_APP_KEY" },
  },
};

describe("runs of a Task with an environment selection", () => {
  const {
    publish,
    putStep,
    postTask,
    getTask,
    claim,
    workerContext,
    requestSecrets,
    runsOf,
    context,
  } = useEnvironmentSelectionProject("selection-runs");

  const startClaimed = async (
    environment: Parameters<typeof postTask>[1],
    source: Parameters<typeof postTask>[0] = { prompt: "Look around" },
  ) => {
    const { task, run } = await unwrapAsync(postTask(source, environment));
    if (!run || task.workItemId === null) throw new Error("Expected a run");
    const claimToken = await claim(task.workItemId, run.id);
    await unwrapAsync(workerContext(run.id, claimToken));
    return { task, run, claimToken };
  };

  const fail = async (taskRunId: string, claimToken: string) => {
    const { apiClient, owner } = context();
    await unwrapAsync(
      apiClient.api["task-runs"]({ taskRunId }).completions.post(
        {
          claimToken,
          status: "failed",
          resultJson: null,
          errorJson: { name: "MergeConflict", message: "rebase failed" },
        },
        { headers: owner.authHeaders },
      ),
    );
  };

  describe("secrets", () => {
    concurrentTest(
      "a run may fetch the secrets its Task's extra connectors name",
      async () => {
        const { run, claimToken } = await startClaimed({
          extraConnectors: [datadog],
        });
        expect(
          await unwrapAsync(
            requestSecrets(run.id, claimToken, [
              "DATADOG_STAGING_KEY",
              "DATADOG_STAGING_APP_KEY",
            ]),
          ),
        ).toEqual({
          secrets: {},
          missing: ["DATADOG_STAGING_KEY", "DATADOG_STAGING_APP_KEY"],
        });
      },
    );

    concurrentTest(
      "a run can't fetch an extra's secret its Task didn't select",
      async () => {
        await startClaimed({ extraConnectors: [datadog] });
        const { run, claimToken } = await startClaimed({
          extraConnectors: [{ connectorId: "playwright", vars: {} }],
        });
        const { error } = await requestSecrets(run.id, claimToken, [
          "DATADOG_STAGING_KEY",
        ]);
        expect(error?.status).toBe(403);
        expect(error?.value).toMatchObject({ code: "SECRET_NOT_REFERENCED" });
      },
    );
  });

  describe("continuations", () => {
    concurrentTest(
      "a manual retry keeps the derived config and extras",
      async () => {
        const name = await publish();
        const { task, run, claimToken } = await startClaimed({
          name,
          extraConnectors: [datadog],
        });
        await fail(run.id, claimToken);
        const { apiClient, owner } = context();
        const retried = await unwrapAsync(
          apiClient.api
            .tasks({ taskId: task.id })
            .retry.post(
              { expectedLatestRunId: run.id },
              { headers: owner.authHeaders },
            ),
        );
        const after = await getTask(task.id);
        expect(after.taskExecutionConfigId).toBe(task.taskExecutionConfigId);
        expect(after.environmentSelection).toEqual(task.environmentSelection);
        const retryRun = (await runsOf(task.id)).find(
          (each) => each.id === retried.taskRunId,
        );
        expect(retryRun?.taskExecutionConfigId).toBe(
          task.taskExecutionConfigId,
        );
        if (!retryRun || task.workItemId === null) {
          throw new Error("Expected the retry run");
        }
        const retryContext = await unwrapAsync(
          workerContext(retryRun.id, await claim(task.workItemId, retryRun.id)),
        );
        expect(retryContext.runtime.environment).toMatchObject({
          kind: "named",
          name,
        });
      },
    );

    concurrentTest(
      "an automatic retry runs on the derived config",
      async () => {
        const name = await publish();
        const step = await putStep({
          errors: ["MergeConflict"],
          retry: [{ on: ["MergeConflict"], maxAttempts: 1 }],
        });
        const { task, run, claimToken } = await startClaimed(
          { name, extraConnectors: [datadog] },
          fromStep(step),
        );
        await fail(run.id, claimToken);
        const runs = await runsOf(task.id);
        expect(runs.map((each) => each.reason)).toEqual(["initial", "retry"]);
        expect(runs[1]?.taskExecutionConfigId).toBe(task.taskExecutionConfigId);
        expect((await getTask(task.id)).environmentSelection).toEqual(
          task.environmentSelection,
        );
      },
    );

    concurrentTest(
      "a reply's continuation runs on the derived config",
      async () => {
        const name = await publish();
        const { task, run, claimToken } = await startClaimed({
          name,
          extraConnectors: [datadog],
        });
        const { apiClient, owner } = context();
        await unwrapAsync(
          apiClient.api["task-runs"]({ taskRunId: run.id }).yields.post(
            { claimToken, message: "Which one?" },
            { headers: owner.authHeaders },
          ),
        );
        const conversationId = (await getTask(task.id)).conversationId;
        if (!conversationId) throw new Error("Expected a conversation");
        await unwrapAsync(
          apiClient.api
            .conversations({ conversationId })
            .messages.post(
              { body: "The first." },
              { headers: owner.authHeaders },
            ),
        );
        const runs = await runsOf(task.id);
        expect(runs.map((each) => each.reason)).toEqual([
          "initial",
          "continuation",
        ]);
        expect(runs[1]?.taskExecutionConfigId).toBe(task.taskExecutionConfigId);
        expect((await getTask(task.id)).environmentSelection).toEqual(
          task.environmentSelection,
        );
      },
    );
  });
});
