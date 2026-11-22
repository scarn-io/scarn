import { describe, expect } from "bun:test";
import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { concurrentTest, unwrapAsync } from "tests/utils";
import {
  createRunnerHarness,
  uniqueKey,
  workItemAutomation,
} from "tests/pipeline-definitions/automation/integration/automation-runner-test-support";
import { childInput } from "./task-run-create-work-item-test-support";

/**
 * A child an agent creates directly with `blockedBy` gets its blocks in the
 * same transaction, so the automation runner never sees it ready while its
 * blocker is open.
 */
describe("task run work item create: readiness", () => {
  concurrentTest(
    "a child created with a blocker doesn't fire child.ready until the blocker closes",
    async () => {
      const h = await createRunnerHarness("create-work-item-ready");
      const [creator, research] = await Promise.all([
        h.createStep("creator", { children: true }),
        h.createStep("research"),
      ]);
      const key = uniqueKey("auto");
      await h.publish(
        workItemAutomation(key, [
          {
            event: "child.ready",
            next: {
              routes: [{ kind: "step", to: research.key, on: "child" }],
            },
          },
        ]),
      );
      const parent = await h.createItem("Parent");
      await h.attach(parent, key);
      const started = await unwrapAsync(
        h.apiClient.api.tasks.post(
          {
            projectId: h.projectId,
            workItemId: parent,
            stepDefinitionId: creator.id,
            stepDefinitionVersion: creator.version,
          },
          { headers: h.headers },
        ),
      );
      const claims = await unwrapAsync(
        h.apiClient.api["task-runs"].claims.post(
          {
            projectId: h.projectId,
            workItemId: parent,
            workerId: `create-work-item-ready-${crypto.randomUUID()}`,
            batchSize: 1,
            leaseDurationSeconds: 30,
          },
          { headers: h.headers },
        ),
      );
      const claim = claims.find((entry) => entry.task.id === started.run?.id);
      if (!claim) {
        throw new Error("Expected to claim the creator's run");
      }
      const create = async (input: ReturnType<typeof childInput>) =>
        await unwrapAsync(
          h.apiClient.api["task-runs"]({ taskRunId: claim.task.id })[
            "work-item-creates"
          ].post(input),
        );
      const blocker = childInput(claim);
      await create(blocker);
      const blockerId = parseUuidV7(blocker.workItemId);
      const blocked = childInput(claim, { blockedBy: [blockerId] });
      await create(blocked);
      const blockedId = parseUuidV7(blocked.workItemId);
      const steps = async (workItemId: UuidV7) =>
        (await h.tasksOn(workItemId)).map((task) => task.step);

      expect(await steps(blockerId)).toEqual([research.key]);
      expect(await steps(blockedId)).toEqual([]);

      await h.setState(blockerId, "closed");

      expect(await steps(blockedId)).toEqual([research.key]);
    },
  );
});
