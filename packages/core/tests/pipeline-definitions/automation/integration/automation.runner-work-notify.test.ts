import { describe, expect } from "bun:test";
import { noopLogger } from "@scarn/observability/logging";
import { runWithWorkNotifyScope } from "@/tasks/task-run/application/work-notifier";
import type { WorkSignal } from "@/tasks/task-run/application/work-signal";
import { concurrentTest, unwrapAsync } from "tests/utils";
import {
  createRunnerHarness,
  projectAutomation,
  uniqueKey,
} from "./automation-runner-test-support";

const recordingWorkSignal = () => {
  const notified: string[] = [];
  const workSignal: WorkSignal = {
    notify: (projectId) => {
      notified.push(projectId);
      return Promise.resolve();
    },
  };
  return { workSignal, notified };
};

/**
 * Runs queued by `AutomationRunner` during a request wake the project's
 * workers: the request's notify scope (opened by `handleRequest` in
 * production, here around the client call) flushes one `WorkSignal.notify`.
 */
describe("automation-triggered runs notify the work signal", () => {
  concurrentTest(
    "closing the last blocker queues the waiting Task's run and notifies once",
    async () => {
      const h = await createRunnerHarness("notify-ready-work");
      const step = await h.createStep("research");
      const blocked = await h.createItem("Blocked");
      const blocker = await h.createItem("Blocker");
      await h.block(blocked, blocker);
      const { task } = await unwrapAsync(
        h.apiClient.api.tasks.post(
          {
            projectId: h.projectId,
            workItemId: blocked,
            stepDefinitionId: step.id,
            stepDefinitionVersion: step.version,
            inputJson: null,
          },
          { headers: h.headers },
        ),
      );
      expect(task.status).toBe("waiting_for_work");
      const { workSignal, notified } = recordingWorkSignal();

      await runWithWorkNotifyScope(workSignal, noopLogger, () =>
        h.setState(blocker, "closed"),
      );

      expect(notified).toEqual([h.projectId]);
      expect(await h.tasksOn(blocked)).toMatchObject([
        { step: step.key, status: "queued" },
      ]);
    },
  );

  concurrentTest(
    "a project automation starting a step on a new item notifies once",
    async () => {
      const h = await createRunnerHarness("notify-automation-step");
      const plan = await h.createStep("plan");
      const key = uniqueKey("triage");
      await h.publish(
        projectAutomation(key, [
          {
            event: "workItem.created",
            next: { routes: [{ kind: "step", to: plan.key, on: "workItem" }] },
          },
        ]),
      );
      await h.enable(key);
      const { workSignal, notified } = recordingWorkSignal();

      const item = await runWithWorkNotifyScope(workSignal, noopLogger, () =>
        h.createItem("Top level"),
      );

      expect(notified).toEqual([h.projectId]);
      expect(await h.tasksOn(item)).toMatchObject([{ step: plan.key }]);
    },
  );
});
